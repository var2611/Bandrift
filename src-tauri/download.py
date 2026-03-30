import urllib.request
import zipfile
import os
import stat

BIN_DIR = "bin"
os.makedirs(BIN_DIR, exist_ok=True)

targets = {
    "iperf3-x86_64-unknown-linux-gnu": "https://github.com/userdocs/iperf3-static/releases/download/3.20/iperf3-amd64",
    "iperf3-x86_64-apple-darwin": "https://github.com/userdocs/iperf3-static/releases/download/3.20/iperf3-amd64-osx-13",
    "iperf3-aarch64-apple-darwin": "https://github.com/userdocs/iperf3-static/releases/download/3.20/iperf3-arm64-osx-15",
    "windows_zip": "https://github.com/userdocs/iperf3-static/releases/download/3.20/iperf3-amd64-win.zip"
}

for name, url in targets.items():
    print(f"Downloading {url}...")
    if name == "windows_zip":
        zip_path = os.path.join(BIN_DIR, "iperf3.zip")
        urllib.request.urlretrieve(url, zip_path)
        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            zip_ref.extractall(BIN_DIR)
        os.remove(zip_path)
        # Assuming the extracted file is iperf3.exe
        if os.path.exists(os.path.join(BIN_DIR, "iperf3.exe")):
            os.rename(os.path.join(BIN_DIR, "iperf3.exe"), os.path.join(BIN_DIR, "iperf3-x86_64-pc-windows-msvc.exe"))
    else:
        file_path = os.path.join(BIN_DIR, name)
        urllib.request.urlretrieve(url, file_path)
        # Make executable
        st = os.stat(file_path)
        os.chmod(file_path, st.st_mode | stat.S_IEXEC)

print("All binaries downloaded successfully!")
