"""Install ONLY the official, checksum-verified Electron runtime in this project.

No npm lifecycle/install script, mirror, shell command or global installation.
"""
import base64
import hashlib
import json
import shutil
import stat
import tarfile
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]
VERSION = "45.2.1"
SRI = "t433yuo8Kh8WG/mTStnPRT/NtpWw8A+caNLJgeU0tS/FlfOkeNEntFsac4ViLgDxZOmDe7BeSkOANVqrqNHhDA=="
vendor = ROOT / ".verification/p6/vendor"
package = vendor / f"electron-{VERSION}.tgz"
assert base64.b64encode(hashlib.sha512(package.read_bytes()).digest()).decode() == SRI
artifact = f"electron-v{VERSION}-win32-x64.zip"
with tarfile.open(package) as archive:
    expected = json.load(archive.extractfile("package/checksums.json"))[artifact]
base = f"https://github.com/electron/electron/releases/download/v{VERSION}/"
with urllib.request.urlopen(base + "SHASUMS256.txt", timeout=30) as response:
    checksums = response.read(2 * 1024 * 1024).decode()
assert any(line.split() == [expected, "*" + artifact] or line.split() == [expected, artifact] for line in checksums.splitlines())
archive_path = vendor / (artifact + "." + uuid4().hex)
checksum = hashlib.sha256()
with urllib.request.urlopen(base + artifact, timeout=60) as response, archive_path.open("xb") as out:
    while chunk := response.read(1024 * 1024):
        checksum.update(chunk)
        out.write(chunk)
assert checksum.hexdigest() == expected, "Runtime checksum mismatch; preserved for investigation."
destination = ROOT / "desktop/node_modules/electron/dist"
assert destination.resolve().is_relative_to(ROOT.resolve()) and not destination.exists()
destination.mkdir()
with zipfile.ZipFile(archive_path) as archive:
    assert sum(info.file_size for info in archive.infolist()) < 2 * 1024**3
    for info in archive.infolist():
        relative = PurePosixPath(info.filename)
        assert not relative.is_absolute() and ".." not in relative.parts and "\\" not in info.filename
        assert not stat.S_ISLNK(info.external_attr >> 16)
        target = destination.joinpath(*relative.parts)
        assert target.resolve().is_relative_to(destination.resolve())
        if info.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info) as source, target.open("xb") as out:
                shutil.copyfileobj(source, out)
assert (destination / "electron.exe").is_file()
assert (destination / "version").read_text().strip().lstrip("v") == VERSION
path_file = destination.parent / "path.txt"
assert not path_file.exists()
path_file.write_text("electron.exe", encoding="utf-8")
result = {"version": VERSION, "source": base + artifact, "sha256": expected,
          "archive_bytes": archive_path.stat().st_size, "archive": str(archive_path),
          "global_software_installed": False, "npm_lifecycle_scripts_executed": False}
(vendor / "electron-runtime.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
print(json.dumps(result))
