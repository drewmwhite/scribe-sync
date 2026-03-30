import pymtp
import subprocess
from pathlib import Path


def connect_device():
    # Release device from GVFS if it has auto-mounted it
    subprocess.run(["pkill", "gvfsd-mtp"], capture_output=True)

    mtp = pymtp.MTP()
    mtp.connect()
    return mtp


def get_device_info(mtp):
    try:
        battery = mtp.get_batterylevel()
    except pymtp.CommandFailed:
        battery = None

    return {
        "manufacturer": mtp.get_manufacturer(),
        "model": mtp.get_modelname(),
        "serial": mtp.get_serialnumber(),
        "battery": battery,
    }


def list_files(mtp):
    """Return all files on the device as a list of MTPFile objects."""
    return list(mtp.get_filelisting())


def decode(value):
    s = value.decode() if isinstance(value, bytes) else value
    return s.strip("\x00")


def find_file(files, filename):
    """Find a file by name."""
    for f in files:
        if decode(f.filename) == filename:
            return f
    return None


def download_file(mtp, f, dest_dir):
    """Download an MTPFile object to dest_dir. Returns the output path."""
    dest = Path(dest_dir) / decode(f.filename)
    mtp.get_file_to_file(f.item_id, str(dest).encode())
    return dest


def print_file_tree(mtp):
    files = list_files(mtp)
    for f in files:
        size_kb = f.filesize / 1024
        name = decode(f.filename)
        print(f"  [{f.item_id:>6}] {name:<50} {size_kb:>8.1f} KB")


if __name__ == "__main__":
    dest = Path("./output")
    dest.mkdir(exist_ok=True)

    print("Connecting to device...")
    mtp = connect_device()

    try:
        info = get_device_info(mtp)
        print(f"Connected: {info['manufacturer']} {info['model']}")
        battery = f"{info['battery']}%" if info['battery'] is not None else "N/A"
        print(f"Battery:   {battery}")
        print()

        files = list_files(mtp)

        for f in files:
            print(repr(decode(f.filename)))

        targets = ["My Clippings.txt", "vocab.db"]

        for filename in targets:
            print(f"Looking for {filename}...")
            f = find_file(files, filename)
            if f:
                path = download_file(mtp, f, dest)
                print(f"  Saved to {path}")
            else:
                print(f"  Not found")

    finally:
        pass  # skip disconnect to avoid unmounting the device
