#!/usr/bin/env python3
"""Verify the stable package against its published per-file commitments."""
import hashlib
import json
import pathlib
import sys
import tarfile

root = pathlib.Path(__file__).resolve().parents[1]
manifest = json.loads((root / "test/fixtures/stable-release-manifest.json").read_text())
expected = {entry["path"]: entry for entry in manifest["files"]}
archive = pathlib.Path(sys.argv[1])
actual = {}
with tarfile.open(archive) as package:
    for entry in package.getmembers():
        path = pathlib.PurePosixPath(entry.name)
        if entry.issym() or entry.islnk() or ".." in path.parts or path.is_absolute():
            raise SystemExit("Unsafe archive member")
        if not entry.isfile():
            continue
        if not path.parts or path.parts[0] != "package":
            raise SystemExit("Unexpected package prefix")
        name = str(pathlib.PurePosixPath(*path.parts[1:]))
        if name in actual:
            raise SystemExit("Duplicate archive member")
        data = package.extractfile(entry).read()
        actual[name] = {"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
if actual != expected:
    raise SystemExit("Packed contents differ from the published stable artifact")
archive_hash = hashlib.sha256(archive.read_bytes()).hexdigest()
print(json.dumps({"ok": True, "files": len(actual), "runtime_contents_match": True,
    "tarball_sha256": archive_hash,
    "tarball_bytes_match": archive_hash == manifest["published_tarball_sha256"]}))
