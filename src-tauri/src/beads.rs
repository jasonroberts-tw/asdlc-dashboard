//! Read-only access to a beads database through the `bd` CLI.
//!
//! Beads 1.x stores issues in Dolt, so the board reads them the way agents do: by running
//! `bd ... --json`. Every invocation passes `--readonly`, so the app never changes the database.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::Value;

/// Searched for `bd` after `PATH`. An app launched from Finder or the Dock inherits a minimal
/// `PATH` that leaves out Homebrew and per-user install locations.
const FALLBACK_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];
const HOME_FALLBACK_DIRS: &[&str] = &[".local/bin", "go/bin", "bin"];

/// Files in the `.beads` directory whose modification time changes when the data does. Reads
/// rewrite Dolt's own files, so those can't be used; bd touches `last-touched` on every write,
/// and `issues.jsonl` changes when a git-synced export is pulled.
const CHANGE_MARKERS: &[&str] = &["last-touched", "issues.jsonl"];

#[derive(Debug, Serialize)]
pub struct Workspace {
    /// The `.beads` directory bd resolved for the chosen folder.
    pub beads_dir: String,
    pub prefix: String,
    /// Status name to category (`active`, `wip`, `done` or `frozen`), built-in and custom.
    pub status_categories: BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
pub struct Board {
    /// Every issue, closed ones included, as `bd list --json` returns them.
    pub issues: Vec<Value>,
    /// Issue ID to the IDs of the open issues blocking it, as `bd blocked` reports them.
    pub blocked_by: BTreeMap<String, Vec<String>>,
}

pub fn open_workspace(dir: &Path) -> Result<Workspace, String> {
    let location = run_bd(dir, &["where"])?;
    let beads_dir = location["path"]
        .as_str()
        .ok_or("bd where did not report a .beads path")?
        .to_string();
    let prefix = location["prefix"].as_str().unwrap_or_default().to_string();
    let statuses = run_bd(dir, &["statuses"])?;
    Ok(Workspace {
        beads_dir,
        prefix,
        status_categories: status_categories(&statuses),
    })
}

pub fn load_board(dir: &Path) -> Result<Board, String> {
    let issues = match run_bd(dir, &["list", "--all", "--limit", "0"])? {
        Value::Array(issues) => issues,
        _ => return Err("bd list did not return a list of issues".into()),
    };
    let blocked = run_bd(dir, &["blocked"])?;
    Ok(Board {
        issues,
        blocked_by: blocked_by(&blocked),
    })
}

/// One issue with its comments and dependents, which `bd list` leaves out.
pub fn load_issue(dir: &Path, id: &str) -> Result<Value, String> {
    let id_arg = format!("--id={id}");
    let shown = run_bd(
        dir,
        &[
            "show",
            &id_arg,
            "--include-comments",
            "--include-dependents",
            "--brief-deps",
        ],
    )?;
    match shown {
        Value::Array(mut issues) if !issues.is_empty() => Ok(issues.swap_remove(0)),
        _ => Err(format!("bd show returned no issue {id}")),
    }
}

/// Latest modification time of the change markers, in milliseconds since the Unix epoch.
pub fn change_marker(beads_dir: &Path) -> Option<u64> {
    CHANGE_MARKERS
        .iter()
        .filter_map(|name| beads_dir.join(name).metadata().ok()?.modified().ok())
        .filter_map(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|since| since.as_millis() as u64)
        .max()
}

fn run_bd(dir: &Path, args: &[&str]) -> Result<Value, String> {
    let dirs = search_dirs();
    let bd = find_executable("bd", &dirs).ok_or(
        "Could not find the bd command. Install beads (https://github.com/steveyegge/beads) \
         or put bd on your PATH.",
    )?;
    let output = Command::new(bd)
        .current_dir(dir)
        .args(["--readonly", "--quiet", "--json"])
        .args(args)
        // bd may start git or dolt, which live in the same directories as bd itself.
        .env(
            "PATH",
            std::env::join_paths(&dirs).map_err(|e| e.to_string())?,
        )
        .env("NO_COLOR", "1")
        .env("BD_NON_INTERACTIVE", "1")
        .output()
        .map_err(|e| format!("Could not run bd: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() {
        return Err(failure_message(
            &stdout,
            &String::from_utf8_lossy(&output.stderr),
        ));
    }
    serde_json::from_str(&stdout)
        .map_err(|e| format!("bd {} returned output that is not JSON: {e}", args[0]))
}

fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> =
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
    dirs.extend(FALLBACK_DIRS.iter().map(PathBuf::from));
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        let home = PathBuf::from(home);
        dirs.extend(HOME_FALLBACK_DIRS.iter().map(|dir| home.join(dir)));
    }
    dirs.dedup();
    dirs
}

fn find_executable(name: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    let mut file_names = vec![OsString::from(name)];
    if cfg!(windows) {
        file_names.push(OsString::from(format!("{name}.exe")));
    }
    dirs.iter()
        .flat_map(|dir| file_names.iter().map(move |file| dir.join(file)))
        .find(|candidate| candidate.is_file())
}

/// A readable reason for a failed bd run. With `--json`, some commands report errors as a JSON
/// object on stdout; the rest print `Error: ...` to stderr, often after permission warnings.
fn failure_message(stdout: &str, stderr: &str) -> String {
    if let Ok(report) = serde_json::from_str::<Value>(stdout) {
        if let Some(message) = report["message"].as_str().or(report["error"].as_str()) {
            return match report["hint"].as_str() {
                Some(hint) => format!("{message} ({hint})"),
                None => message.to_string(),
            };
        }
    }
    let errors: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.to_ascii_lowercase().starts_with("warning:"))
        .collect();
    if errors.is_empty() {
        "bd failed without saying why".into()
    } else {
        errors.join("\n")
    }
}

fn status_categories(statuses: &Value) -> BTreeMap<String, String> {
    ["built_in_statuses", "custom_statuses"]
        .iter()
        .filter_map(|key| statuses[key].as_array())
        .flatten()
        .filter_map(|status| {
            Some((
                status["name"].as_str()?.to_string(),
                status["category"].as_str()?.to_string(),
            ))
        })
        .collect()
}

fn blocked_by(blocked: &Value) -> BTreeMap<String, Vec<String>> {
    blocked
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|issue| {
            let blockers = issue["blocked_by"]
                .as_array()?
                .iter()
                .filter_map(|id| Some(id.as_str()?.to_string()))
                .collect();
            Some((issue["id"].as_str()?.to_string(), blockers))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn failure_message_prefers_json_report_with_hint() {
        let stdout = r#"{"error":"no_beads_directory","hint":"run 'bd init'","message":"No active beads workspace found."}"#;
        assert_eq!(
            failure_message(stdout, "ignored"),
            "No active beads workspace found. (run 'bd init')"
        );
    }

    #[test]
    fn failure_message_drops_warnings_from_stderr() {
        let stderr = "Warning: /x/.beads has permissions 0755\nwarning: no beads configuration found\nError: no beads database found\n";
        assert_eq!(
            failure_message("", stderr),
            "Error: no beads database found"
        );
    }

    #[test]
    fn failure_message_falls_back_when_nothing_is_said() {
        assert_eq!(
            failure_message("", "Warning: noise\n"),
            "bd failed without saying why"
        );
    }

    #[test]
    fn status_categories_merge_built_in_and_custom() {
        let statuses = json!({
            "built_in_statuses": [{"name": "open", "category": "active"}, {"name": "closed", "category": "done"}],
            "custom_statuses": [{"name": "review", "category": "wip"}],
        });
        let categories = status_categories(&statuses);
        assert_eq!(categories.len(), 3);
        assert_eq!(categories["review"], "wip");
        assert_eq!(categories["open"], "active");
    }

    #[test]
    fn status_categories_tolerate_missing_custom_list() {
        let statuses = json!({"built_in_statuses": [{"name": "open", "category": "active"}], "custom_statuses": null});
        assert_eq!(status_categories(&statuses).len(), 1);
    }

    #[test]
    fn blocked_by_maps_issue_to_blockers() {
        let blocked = json!([
            {"id": "demo-3cq", "blocked_by": ["demo-r7a", "demo-9x"]},
            {"id": "demo-no-list"},
        ]);
        let map = blocked_by(&blocked);
        assert_eq!(map.len(), 1);
        assert_eq!(map["demo-3cq"], vec!["demo-r7a", "demo-9x"]);
    }

    #[test]
    fn find_executable_searches_dirs_in_order() {
        let root = std::env::temp_dir().join(format!("beads-find-{}", std::process::id()));
        let (first, second) = (root.join("first"), root.join("second"));
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        std::fs::write(second.join("bd"), "").unwrap();

        let dirs = [first.clone(), second.clone()];
        assert_eq!(find_executable("bd", &dirs), Some(second.join("bd")));
        assert_eq!(find_executable("missing", &dirs), None);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn change_marker_reports_latest_marker() {
        let dir = std::env::temp_dir().join(format!("beads-marker-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(change_marker(&dir), None);

        std::fs::write(dir.join("last-touched"), "demo-1").unwrap();
        assert!(change_marker(&dir).is_some());
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Runs the real bd against a throwaway workspace: `cargo test -- --ignored`.
    #[test]
    #[ignore = "needs bd on PATH"]
    fn reads_a_real_workspace() {
        let dir = std::env::temp_dir().join(format!("beads-live-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bd = find_executable("bd", &search_dirs()).expect("bd on PATH");
        let bd_ok = |args: &[&str]| {
            let status = Command::new(&bd)
                .current_dir(&dir)
                .args(args)
                .output()
                .unwrap()
                .status;
            assert!(status.success(), "bd {args:?} failed");
        };
        Command::new("git")
            .arg("init")
            .arg("-q")
            .current_dir(&dir)
            .status()
            .unwrap();
        bd_ok(&["init", "--non-interactive", "-q", "-p", "live"]);
        bd_ok(&["-q", "create", "Blocker", "--id", "live-a"]);
        bd_ok(&["-q", "create", "Blocked", "--id", "live-b"]);
        bd_ok(&["-q", "dep", "add", "live-b", "live-a"]);

        let workspace = open_workspace(&dir).unwrap();
        assert_eq!(workspace.prefix, "live");
        assert_eq!(workspace.status_categories["closed"], "done");

        let board = load_board(&dir).unwrap();
        assert_eq!(board.issues.len(), 2);
        assert_eq!(board.blocked_by["live-b"], vec!["live-a"]);

        let issue = load_issue(&dir, "live-b").unwrap();
        assert_eq!(issue["id"], "live-b");
        assert!(change_marker(Path::new(&workspace.beads_dir)).is_some());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
