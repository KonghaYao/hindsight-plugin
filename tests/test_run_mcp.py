"""Regression tests for scripts/run_mcp.sh venv interpreter resolution.

`run_mcp.sh` resolves the plugin venv's Python interpreter with a bash
`resolve_py()` helper before either exec-ing it or (if missing) re-creating
the venv. The probe must understand every venv layout the plugin can run on:

  - POSIX:                       ``<venv>/bin/python``
  - msys2 / mingw (git-bash):    ``<venv>/bin/python.exe``  (added in #1564)
  - standard Windows CPython:    ``<venv>/Scripts/python.exe``

The third layout is what the python.org installer, the Windows Store Python,
and ``py -m venv`` all produce — the *common* Windows case. Before the
``Scripts/`` branch existed, ``resolve_py`` returned an empty ``$PY`` on those
venvs, so the launcher fell through to venv re-creation, which then failed
whenever ``python``/``python3`` were not on the spawning process's PATH (issue
#1758, sub-item 3a). These tests invoke the real bash function against a
fabricated venv tree and assert on the interpreter it selects.

The launcher also decides whether an existing venv needs re-pipping; that
decision is covered by ``TestVenvRepair``.
"""

import os
import stat
import subprocess
import textwrap

SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "..", "scripts")
RUN_MCP_SH = os.path.abspath(os.path.join(SCRIPTS_DIR, "run_mcp.sh"))


def _resolve_py(venv_dir: str) -> str:
    """Run run_mcp.sh's ``resolve_py`` against ``venv_dir`` and return ``$PY``.

    The script's top-level body (which would actually create a venv and exec a
    server) is never run: a tiny driver sources only the ``resolve_py``
    function definition out of the file, sets ``VENV``, calls it, and echoes
    ``$PY``. This keeps the test hermetic and exercises the exact shell logic
    that ships.
    """
    driver = textwrap.dedent(
        """
        set -e
        # Extract just the resolve_py function definition from the script and
        # evaluate it, so none of the script's top-level side effects run.
        func="$(sed -n '/^resolve_py() {/,/^}/p' "$1")"
        eval "$func"
        VENV="$2"
        resolve_py
        printf '%s' "$PY"
        """
    )
    result = subprocess.run(
        ["bash", "-c", driver, "bash", RUN_MCP_SH, venv_dir],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def _make_executable(path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("#!/usr/bin/env python\n")
    os.chmod(path, 0o755)


def _run_tail_with_fake_exec(plugin_data: str, plugin_root: str, snippet) -> str:
    """Run the launcher tail with a fake exec and return project/server cwd.

    The tail is staged into ``snippet`` and sourced from there rather than piped
    into `source /dev/stdin`: on macOS that pipeline form silently reads nothing
    (`source` just sees EOF and the driver still exits 0), which would leave the
    assertions below passing without ever running the launcher code.
    """
    driver = textwrap.dedent(
        """
        set -e
        export CLAUDE_PLUGIN_DATA="$1"
        export CLAUDE_PLUGIN_ROOT="$2"
        PY=python
        exec() { printf '%s\n%s' "$HINDSIGHT_MCP_PROJECT_CWD" "$(pwd)"; }
        sed -n '/^export HINDSIGHT_MCP_PROJECT_CWD=/,$p' "$3" > "$4"
        source "$4"
        """
    )
    result = subprocess.run(
        ["bash", "-c", driver, "bash", plugin_data, plugin_root, RUN_MCP_SH, str(snippet)],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


class TestResolvePyVenvLayouts:
    """`resolve_py` must find the interpreter in every supported venv layout."""

    def test_windows_scripts_layout_is_resolved(self, tmp_path):
        """Standard Windows CPython venv: interpreter lives in ``Scripts/``.

        RED before the fix: ``resolve_py`` only probed ``bin/`` and returned an
        empty ``$PY`` for this (common) layout, triggering a doomed venv
        re-creation (issue #1758/3a). GREEN after the ``Scripts/`` branch.
        """
        venv = tmp_path / "venv"
        scripts_python = venv / "Scripts" / "python.exe"
        _make_executable(str(scripts_python))
        # Deliberately no bin/ — this is the genuine Windows layout.
        assert not (venv / "bin").exists()

        resolved = _resolve_py(str(venv))

        assert resolved == str(scripts_python), (
            "resolve_py must select <venv>/Scripts/python.exe for a standard "
            "Windows CPython venv; got: " + repr(resolved)
        )

    def test_posix_bin_layout_is_resolved(self, tmp_path):
        """Regression guard: the POSIX ``bin/python`` path still wins."""
        venv = tmp_path / "venv"
        bin_python = venv / "bin" / "python"
        _make_executable(str(bin_python))

        resolved = _resolve_py(str(venv))

        assert resolved == str(bin_python), (
            "resolve_py must still select <venv>/bin/python on POSIX; got: "
            + repr(resolved)
        )


class TestMcpServerWorkingDirectory:
    """The launcher must not run the server from Claude Code's project cwd."""

    def test_exec_runs_from_plugin_data_dir_when_project_env_is_unreadable(self, tmp_path):
        """FastMCP probes `.env` in cwd, so use the plugin-owned data dir."""
        project = tmp_path / "project"
        project.mkdir()
        env_file = project / ".env"
        env_file.write_text("SECRET=value\n")
        env_file.chmod(stat.S_IRUSR | stat.S_IWUSR)
        plugin_data = tmp_path / "plugin-data"
        plugin_root = tmp_path / "plugin-root"
        plugin_root.mkdir()

        previous = os.getcwd()
        try:
            os.chdir(project)
            project_cwd, server_cwd = _run_tail_with_fake_exec(
                str(plugin_data), str(plugin_root), tmp_path / "tail.sh"
            ).splitlines()
        finally:
            os.chdir(previous)

        assert project_cwd == str(project)
        assert server_cwd == str(plugin_data)


REQUIREMENTS = "# mcp>=2 removed mcp.server.fastmcp, which scripts/mcp_server.py imports.\nmcp>=1.0.0,<2\n"

# Sources only the re-pip block of run_mcp.sh (no venv creation, no exec) with
# the interpreter and pip replaced by stubs that record their invocations.
_REPIP_DRIVER = textwrap.dedent(
    """
    set -e
    PY="$1"
    PIP="$2"
    REQ_SRC="$3"
    REQ_CACHED="$4"
    sed -n '/^# Re-pip only when/,/^fi$/p' "$5" > "$6"
    source "$6"
    """
)


class TestVenvRepair:
    """The re-pip decision must probe the API the server imports.

    ``mcp>=2`` removed ``mcp.server.fastmcp`` (imported by
    ``scripts/mcp_server.py``) while the top-level ``mcp`` package still
    imports fine. Probing ``import mcp`` — as the launcher used to — therefore
    leaves an incompatible venv in place and the server dies at startup with
    ``No module named 'mcp.server.fastmcp'``.
    """

    @staticmethod
    def _stub_interpreter(path, log, mcp_1x_api_importable: bool):
        """Interpreter stand-in: records probes, fails the mcp 1.x API probe."""
        body = textwrap.dedent(
            f"""
            #!/usr/bin/env bash
            printf '%s\\n' "$*" >> {log}
            if [ "$1" = "-c" ]; then
              case "$2" in
                *mcp.server.fastmcp*) exit {0 if mcp_1x_api_importable else 1} ;;
                *mcp*) exit 0 ;;
              esac
            fi
            exit 0
            """
        )
        path.write_text(body)
        os.chmod(path, 0o755)
        return str(path)

    @staticmethod
    def _stub_pip(path, log):
        body = textwrap.dedent(
            f"""
            #!/usr/bin/env bash
            printf '%s\\n' "$*" >> {log}
            exit 0
            """
        )
        path.write_text(body)
        os.chmod(path, 0o755)
        return str(path)

    def _run_repip(self, tmp_path, mcp_1x_api_importable: bool):
        plugin_root = tmp_path / "plugin-root"
        plugin_root.mkdir()
        req_src = plugin_root / "requirements.txt"
        req_src.write_text(REQUIREMENTS)
        plugin_data = tmp_path / "plugin-data"
        plugin_data.mkdir()
        req_cached = plugin_data / "requirements.txt"
        # Cache matches the shipped requirements, so only the import probe can
        # decide whether this venv needs re-pipping.
        req_cached.write_text(REQUIREMENTS)

        probe_log = tmp_path / "probe.log"
        pip_log = tmp_path / "pip.log"
        result = subprocess.run(
            [
                "bash",
                "-c",
                _REPIP_DRIVER,
                "bash",
                self._stub_interpreter(
                    tmp_path / "python", probe_log, mcp_1x_api_importable
                ),
                self._stub_pip(tmp_path / "pip", pip_log),
                str(req_src),
                str(req_cached),
                RUN_MCP_SH,
                str(tmp_path / "repip.sh"),
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        assert result.returncode == 0
        return probe_log, pip_log, req_src

    def test_venv_without_mcp_1x_api_is_reinstalled(self, tmp_path):
        """RED before the fix: ``import mcp`` succeeded, so no re-pip happened."""
        probe_log, pip_log, req_src = self._run_repip(tmp_path, mcp_1x_api_importable=False)

        assert "mcp.server.fastmcp" in probe_log.read_text(), (
            "the probe must import the module the server uses; got: "
            + probe_log.read_text()
        )
        assert pip_log.exists(), "an incompatible mcp major must trigger re-pip"
        assert f"install --quiet -r {req_src}" in pip_log.read_text(), (
            "re-pip must install the shipped requirements; got: " + pip_log.read_text()
        )

    def test_compatible_venv_skips_pip(self, tmp_path):
        """Warm starts stay cheap: a working venv is exec'd, not re-pipped."""
        _probe_log, pip_log, _req_src = self._run_repip(tmp_path, mcp_1x_api_importable=True)

        assert not pip_log.exists(), "a healthy venv must not be re-pipped"
