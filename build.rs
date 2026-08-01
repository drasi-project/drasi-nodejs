extern crate napi_build;

use std::{env, fs, path::Path};

fn main() {
    napi_build::setup();

    // The plugin resolver (`resolvePlugin` / `installPlugin`) matches plugin
    // artifacts against the versions of the Drasi crates this addon is built
    // against, and selects the artifact built for this target platform. Capture
    // both at build time so the binding can construct a `HostVersionInfo`
    // without hard-coding versions that would drift from Cargo.toml/Cargo.lock.
    let target = env::var("TARGET").expect("cargo sets TARGET for build scripts");
    println!("cargo:rustc-env=DRASI_TARGET_TRIPLE={target}");

    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by cargo");
    let lock_path = Path::new(&manifest_dir).join("Cargo.lock");
    println!("cargo:rerun-if-changed={}", lock_path.display());
    let lock = fs::read_to_string(&lock_path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", lock_path.display()));

    for (crate_name, var) in [
        ("drasi-lib", "DRASI_LIB_VERSION"),
        ("drasi-core", "DRASI_CORE_VERSION"),
        ("drasi-plugin-sdk", "DRASI_SDK_VERSION"),
    ] {
        let version = cargo_lock_version(&lock, crate_name).unwrap_or_else(|| {
            panic!("{crate_name} not found in Cargo.lock — cannot embed its version")
        });
        println!("cargo:rustc-env={var}={version}");
    }
}

/// Extract the `version` of the `[[package]]` named `name` from a Cargo.lock.
fn cargo_lock_version(lock: &str, name: &str) -> Option<String> {
    let mut in_package = false;
    let mut is_target = false;
    for line in lock.lines() {
        let line = line.trim();
        if line == "[[package]]" {
            in_package = true;
            is_target = false;
        } else if in_package {
            if let Some(rest) = line.strip_prefix("name = \"") {
                is_target = rest.trim_end_matches('"') == name;
            } else if is_target {
                if let Some(rest) = line.strip_prefix("version = \"") {
                    return Some(rest.trim_end_matches('"').to_string());
                }
            }
        }
    }
    None
}
