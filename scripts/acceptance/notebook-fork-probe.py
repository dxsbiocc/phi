#!/usr/bin/env python3
"""Bounded Linux-only diagnostic; no Phi, Jupyter, models, network or config changes.

Run with the intended Python: python notebook-fork-probe.py [case]
Cases: trap-epoll (default), none-epoll, usr1-epoll, trap-sleep.
Exit 0: fork completed; 124: timed out; 2: unsupported environment/invalid case.
This diagnoses the execution environment, not Notebook feature acceptance.
"""
import os
import select
import signal
import sys
import threading
import time

CASES = {"trap-epoll", "none-epoll", "usr1-epoll", "trap-sleep"}


def exercise(case):
    ready = threading.Event()

    finished = threading.Event()
    errors = []

    def wait_in_thread():
        try:
            if case.startswith("trap"):
                signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTRAP})
            elif case.startswith("usr1"):
                signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGUSR1})
            poller = select.epoll()
            ready.set()
            if case.endswith("epoll"):
                poller.poll()
            else:
                time.sleep(30)
        except BaseException as error:
            errors.append(error)
        finally:
            finished.set()
            ready.set()

    worker = threading.Thread(target=wait_in_thread, daemon=True)
    worker.start()
    if not ready.wait(2):
        raise RuntimeError("test thread did not start")
    time.sleep(0.2)
    if errors:
        raise RuntimeError("test thread failed") from errors[0]
    if finished.is_set() or not worker.is_alive():
        raise RuntimeError("test thread ended before fork")
    print("before-fork", case, flush=True)
    pid = os.fork()
    if pid == 0:
        os._exit(0)
    _, status = os.waitpid(pid, 0)
    if os.waitstatus_to_exitcode(status) != 0:
        raise RuntimeError("forked child failed")
    if errors or finished.is_set():
        raise RuntimeError("test thread ended during fork")
    print("fork-ok", case, flush=True)


def main():
    case = sys.argv[1] if len(sys.argv) == 2 else "trap-epoll"
    if len(sys.argv) > 2 or case not in CASES:
        print("invalid case", file=sys.stderr)
        return 2
    if sys.platform != "linux" or not hasattr(select, "epoll"):
        print("this diagnostic requires Linux with epoll", file=sys.stderr)
        return 2
    print("python", sys.version.split()[0], "arch", os.uname().machine,
          "uid", os.getuid(), "case", case, flush=True)
    # The supervisor never creates threads; only its owned process group runs the
    # potentially hanging case. Avoid subprocess/Jupyter dependencies in this probe.
    interrupts = {signal.SIGINT, signal.SIGTERM}
    old_mask = signal.pthread_sigmask(signal.SIG_BLOCK, interrupts)
    old_handlers = {sig: signal.getsignal(sig) for sig in interrupts}
    child, reaped = None, False

    def interrupted(sig, _frame):
        raise SystemExit(128 + sig)

    try:
        for sig in interrupts:
            signal.signal(sig, interrupted)
        child = os.fork()
        if child == 0:
            try:
                os.setsid()
                for sig, handler in old_handlers.items():
                    signal.signal(sig, handler)
                signal.pthread_sigmask(signal.SIG_SETMASK, old_mask)
                exercise(case)
            except BaseException as error:
                print(type(error).__name__, str(error), file=sys.stderr, flush=True)
                os._exit(2)
            os._exit(0)
        signal.pthread_sigmask(signal.SIG_SETMASK, old_mask)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            # Keep the ownership flag consistent even if interrupted while reaping.
            previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, interrupts)
            try:
                done, status = os.waitpid(child, os.WNOHANG)
                if done:
                    reaped = True
                    return os.waitstatus_to_exitcode(status)
            finally:
                signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
            time.sleep(0.05)
        print("fork-timeout", case, file=sys.stderr, flush=True)
        return 124
    finally:
        signal.pthread_sigmask(signal.SIG_BLOCK, interrupts)
        if child is not None and child > 0 and not reaped:
            try:
                os.killpg(child, signal.SIGKILL)
            except ProcessLookupError:
                # The child may not have reached setsid yet.
                try:
                    os.kill(child, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            os.waitpid(child, 0)
        for sig, handler in old_handlers.items():
            signal.signal(sig, handler)
        signal.pthread_sigmask(signal.SIG_SETMASK, old_mask)


if __name__ == "__main__":
    sys.exit(main())
