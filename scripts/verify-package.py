"""Verify an installation ZIP, its source correspondence and helper file modes."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import stat
import struct
import sys
import zipfile

archive = Path(sys.argv[1]).resolve()
root = Path(__file__).resolve().parent.parent
checksum, filename = archive.with_name(archive.name + '.sha256').read_text().strip().split()
assert filename == archive.name, 'Checksum filename mismatch'
assert hashlib.sha256(archive.read_bytes()).hexdigest() == checksum, 'Checksum mismatch'

with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None, 'ZIP CRC failure'
    files = set()
    for info in z.infolist():
        name = PurePosixPath(info.filename)
        assert not name.is_absolute() and '..' not in name.parts and '\\' not in info.filename, 'Unsafe ZIP path'
        assert not stat.S_ISLNK(info.external_attr >> 16), 'Unexpected symlink'
        if info.is_dir():
            continue
        assert info.filename not in files, 'Duplicate ZIP entry'
        files.add(info.filename)
        local = root.joinpath(*name.parts)
        assert local.is_file(), 'Archive includes a file absent from source tree'
        assert hashlib.sha256(z.read(info)).digest() == hashlib.sha256(local.read_bytes()).digest(), 'Archive differs from current source tree'
    manifest = json.loads(z.read('plugin.json'))
    package = json.loads(z.read('package.json'))
    lock = json.loads(z.read('package-lock.json'))
    assert manifest['id'] == 'music-fusion'
    assert manifest['version'] == package['version'] == lock['version'] == lock['packages']['']['version']
    assert manifest['main'] in files
    assert 'src/providers/qqmusic/auth-app.js' in files
    assert 'native/qqmusic-login/go.mod' in files and 'native/qqmusic-login/go.sum' in files
    assert 'native/qqmusic-login/vendor/modules.txt' in files
    assert 'native/qqmusic-login/vendor/github.com/coder/websocket/conn.go' in files
    assert 'native/qqmusic-login/THIRD_PARTY_NOTICES.md' in files
    assert any(name.startswith('native/qqmusic-login/') and name.endswith('.go') for name in files)
    expected = set()
    for os in ('darwin', 'linux', 'windows'):
        for arch in ('arm64', 'amd64'):
            name = f'bin/qqmusic-login-{os}-{arch}' + ('.exe' if os == 'windows' else '')
            expected.add(name)
            info = z.getinfo(name)
            assert (info.external_attr >> 16) & 0o111, 'Helper lost its executable mode'
            data = z.read(name)
            if os == 'darwin':
                assert data[:4] == b'\xcf\xfa\xed\xfe', 'Invalid Mach-O helper'
                cpu = struct.unpack_from('<I', data, 4)[0]
                assert cpu == (0x100000C if arch == 'arm64' else 0x1000007), 'Wrong Mach-O architecture'
            elif os == 'linux':
                assert data[:6] == b'\x7fELF\x02\x01', 'Invalid ELF64 helper'
                assert struct.unpack_from('<H', data, 18)[0] == (183 if arch == 'arm64' else 62), 'Wrong ELF architecture'
            else:
                assert data[:2] == b'MZ', 'Invalid Windows helper'
                offset = struct.unpack_from('<I', data, 60)[0]
                assert data[offset:offset + 4] == b'PE\x00\x00', 'Invalid PE helper'
                assert struct.unpack_from('<H', data, offset + 4)[0] == (0xAA64 if arch == 'arm64' else 0x8664), 'Wrong PE architecture'
    assert set(manifest['permissions']['process']) == expected, 'Helper permissions mismatch'
    assert {name for name in files if name.startswith('bin/')} == expected, 'Unexpected packaged executable'
    total = sum(i.file_size for i in z.infolist())
print(f'ZIP verified: version {manifest["version"]}; {len(files)} matching source/artifact files; six correct native formats and executable modes.')
print(f'Archive {archive.stat().st_size} bytes; unpacked {total} bytes; SHA256 {checksum}')
