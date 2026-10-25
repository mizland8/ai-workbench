//! Explicit, one-shot OS firewall setup. Never runs during startup or status refresh.
use serde_json::{json, Value};
use std::{net::Ipv4Addr, path::Path, process::Command};
use tauri::State;

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn powershell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}
fn encoded_powershell(script: &str) -> String {
    use base64::Engine;
    let bytes: Vec<_> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
fn windows_script(executable: &Path, port: u16) -> String {
    let exe = powershell_quote(&executable.to_string_lossy());
    format!("$ErrorActionPreference='Stop'; $name='AIWorkbench-LAN-{port}'; $rule=Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue; if ($rule) {{ $rule | Remove-NetFirewallRule }}; New-NetFirewallRule -Name $name -DisplayName 'AI Workbench local Wi-Fi ({port})' -Direction Inbound -Action Allow -Protocol TCP -LocalPort {port} -Program {exe} -Profile Private -RemoteAddress LocalSubnet -EdgeTraversalPolicy Block | Out-Null")
}
fn mac_script(executable: &Path) -> String {
    let exe = shell_quote(&executable.to_string_lossy());
    let command = format!("/usr/libexec/ApplicationFirewall/socketfilterfw --add {exe} && /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp {exe}");
    format!(
        "do shell script {} with administrator privileges",
        serde_json::to_string(&command).unwrap()
    )
}
fn local_subnets() -> Result<Vec<String>, String> {
    let mut networks = vec![];
    let addresses = crate::companion::lan_addresses();
    for interface in if_addrs::get_if_addrs().map_err(|e| e.to_string())? {
        if let if_addrs::IfAddr::V4(addr) = interface.addr {
            if !addresses.contains(&addr.ip) || addr.netmask.is_unspecified() {
                continue;
            }
            let mask = u32::from(addr.netmask);
            // Refuse malformed or overly broad masks instead of opening arbitrary networks.
            let prefix = mask.leading_ones();
            if prefix < 8 || mask != u32::MAX.checked_shl(32 - prefix).unwrap_or(0) {
                continue;
            }
            let network = Ipv4Addr::from(u32::from(addr.ip) & mask);
            networks.push(format!("{network}/{prefix}"));
        }
    }
    networks.sort();
    networks.dedup();
    if networks.is_empty() {
        return Err("Connect this PC to Wi-Fi or Ethernet first.".into());
    }
    Ok(networks)
}
fn linux_script(ufw: &Path, networks: &[String], port: u16) -> String {
    networks
        .iter()
        .map(|network| {
            format!(
                "{} allow from {} to any port {port} proto tcp comment 'AI Workbench local Wi-Fi'",
                shell_quote(&ufw.to_string_lossy()),
                shell_quote(network)
            )
        })
        .collect::<Vec<_>>()
        .join(" && ")
}
fn setup(port: u16) -> Result<String, String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let os = std::env::consts::OS;
    let mut command;
    let result = match os {
        "windows" => {
            let encoded = encoded_powershell(&windows_script(&executable, port));
            command = Command::new("powershell.exe");
            command.args(["-NoProfile", "-NonInteractive", "-Command", &format!("$ErrorActionPreference='Stop'; try {{ $p=Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList '-NoProfile -NonInteractive -EncodedCommand {encoded}'; exit $p.ExitCode }} catch {{ Write-Error $_; exit 1 }}")]);
            "Wi-Fi rule configured for Workbench on Windows Private networks. If needed, mark your trusted home Wi-Fi as Private in Windows Settings."
        }
        "macos" => {
            command = Command::new("osascript");
            command.args(["-e", &mac_script(&executable)]);
            "Workbench is allowed through the macOS application firewall. If macOS asks for Local Network access, allow it in System Settings → Privacy & Security → Local Network."
        }
        "linux" => {
            let ufw = which::which("ufw").map_err(|_| "Automatic setup supports UFW on Linux. Allow the Workbench TCP port in your firewall, then try pairing again.".to_string())?;
            let script = linux_script(&ufw, &local_subnets()?, port);
            command = Command::new("pkexec");
            command.args(["/bin/sh", "-c", &script]);
            "Local Wi-Fi firewall rule configured. Paste a fresh pairing code into the phone. If your Wi-Fi subnet changes, run this setup again."
        }
        _ => return Err("Allow the Workbench TCP port in this computer's firewall.".into()),
    };
    // The system owns authentication. No password is read, stored, or passed by Workbench.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command
        .output()
        .map_err(|e| format!("Could not open system network setup: {e}"))?;
    if !output.status.success() {
        return Err("Network setup was cancelled or denied. No retry will run automatically. You can allow Workbench in your OS firewall settings or press Allow Wi-Fi connections to retry.".into());
    }
    Ok(result.into())
}
#[tauri::command]
pub async fn companion_network_setup(
    companion: State<'_, crate::companion::Companion>,
) -> Result<Value, String> {
    let status = crate::companion::companion_status(companion);
    let port = status["port"]
        .as_u64()
        .filter(|_| status["enabled"] == true)
        .ok_or("Enable linking first")? as u16;
    tauri::async_runtime::spawn_blocking(move || {
        setup(port).map(|message| json!({"message":message}))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn elevated_scripts_keep_paths_literal_and_rules_scoped() {
        let win = windows_script(Path::new("C:\\O'Brien $x\\Workbench.exe"), 47931);
        assert!(win.contains("-Program 'C:\\O''Brien $x\\Workbench.exe'"));
        assert!(win.contains("-Profile Private -RemoteAddress LocalSubnet"));
        assert!(win.contains("-LocalPort 47931"));
        let mac = mac_script(Path::new(
            "/Applications/It's $(touch nope).app/Contents/MacOS/workbench",
        ));
        assert!(mac.contains("'\\\\''"));
        let linux = linux_script(Path::new("/usr/bin/ufw"), &["10.0.0.0/24".into()], 47931);
        assert_eq!(linux, "'/usr/bin/ufw' allow from '10.0.0.0/24' to any port 47931 proto tcp comment 'AI Workbench local Wi-Fi'");
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded_powershell(&win))
            .unwrap();
        let decoded = String::from_utf16(
            &bytes
                .as_chunks::<2>()
                .0
                .iter()
                .map(|b| u16::from_le_bytes([b[0], b[1]]))
                .collect::<Vec<_>>(),
        )
        .unwrap();
        assert_eq!(decoded, win);
    }
}
