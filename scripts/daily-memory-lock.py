import fcntl
import os
import pathlib
import sys

# Honor GBRAIN_DAILY_MEMORY_STATE (same default as gbrain-daily-memory.sh).
state = pathlib.Path(
    os.environ.get('GBRAIN_DAILY_MEMORY_STATE')
    or (pathlib.Path.home() / '.local/state/gbrain')
)
state.mkdir(parents=True, exist_ok=True)
path = state / 'daily-memory.flock'
fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print('daily-memory writer already running')
    raise SystemExit(0)
# Keep the locked inode in place; kernel release handles exit and crashes.
if fd != 9:
    os.dup2(fd, 9, inheritable=True)
    os.close(fd)
else:
    os.set_inheritable(9, True)
os.environ['GBRAIN_DAILY_LOCK_FD'] = '9'
os.execv('/bin/bash', ['/bin/bash', *sys.argv[1:]])
