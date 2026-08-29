# MPyTools

MPyTools is a Visual Studio Code extension for selecting a MicroPython device,
using its REPL, managing files, compiling `.py` files to `.mpy`, uploading a
project, and keeping local firmware snapshots.

## First-time setup

1. Install the extension and make sure Python 3 with `venv` support is available.
2. Run **MPY: Install Managed Toolchain**. MPyTools creates an isolated Python
   environment in VS Code extension storage and installs compatible `mpremote`
   and `mpy-cross` versions there. It never installs into the system Python.
3. Connect the board and run **MPY: Select Port**.
4. If connection fails, run **MPY: Diagnostics** and inspect the MPyTools output.

An existing `mpremote` from `PATH` is supported. A custom executable can be set
with `mpytools.mpremotePath`. The explicit setting has priority, followed by the
managed installation, `PATH`, and `python -m mpremote`.

### Linux serial access

MPyTools preserves absolute port paths returned by `mpremote`, such as
`/dev/ttyACM0`, and remembers a device by USB serial number when one is exposed.
It also reports whether a failure is caused by a missing port, permissions, a
busy device, or a missing toolchain.

On Debian/Ubuntu-style systems, serial users commonly need membership in the
`dialout` group:

```sh
sudo usermod -aG dialout "$USER"
```

Log out and back in after changing group membership. Other distributions may
use a different group or `uaccess` udev rules. A sandboxed VS Code installation
must also be allowed to access USB/serial devices. The diagnostics command shows
the current groups, visible ports, access mode, selected tool source, and a
read-only connection check.

## Toolchain and reinstall behaviour

- Python packages are isolated from PEP 668/system-package restrictions.
- Commands are started with argument arrays, not through a shell, so paths with
  spaces and special characters work on Windows, Linux, and macOS.
- Managed tools live in versioned extension storage and are reused after an
  extension update. If an uninstall removes that storage, the extension detects
  the missing tools and offers to recreate them.
- Workspace stubs are installed only under `.mpytools/typings`; MPyTools does not
  replace a user's `typings` folder or `pyproject.toml`.
- Project ZIP files are created by the extension itself; an external `zip`
  command is not required.

## Main commands

- **MPY: Select Port** — list ports reported by `mpremote` and validate the
  selected MicroPython device.
- **MPY: Open REPL** — open one MPyTools-owned interactive terminal.
- **MPY: Run Active File** — run the current file without shell interpolation.
- **MPY: Compile and Run** — build in VS Code's workspace-scoped extension
  storage, upload, and start the project. Generated build files stay outside the
  workspace so file watchers, Git integrations, and language servers do not
  rescan the project during compilation.
- **MPY: Install Workspace Stubs** — install project-local completion stubs.
- **MPY: Diagnostics** — inspect toolchain and serial access without changing the
  device.

## Project firmware versioning

Projects can opt in with a `.mpytools.json` file:

```json
{
  "versioning": {
    "enabled": true,
    "generator": "tools/generate_fw_version.py",
    "output": "src/generated/fw_version.py",
    "autoSnapshot": true,
    "snapshotDirectory": ".save/mpytools-builds"
  }
}
```

Before **Compile and Run**, MPyTools runs the configured generator. A generator
error stops the build. After a successful upload, one local source snapshot per
firmware version is retained.

### Build inputs and assets

MPyTools never compiles Python caches or generated development folders such as
`__pycache__`, `*.pyc`, `.venv`, `.git`, `node_modules`, and test/tool caches.
When non-`.py` wrapping is enabled, only extensions listed in
`mpytools.wrappableAssetExtensions` are converted into importable modules.
Other resources, including binary files, are copied unchanged. Build caches are
automatically invalidated when the extension version, compiler settings, asset
settings, or MicroPython ABI changes.

Generated upload files use the classic visible `<project>/mpy` folder by
default, with no setup required. MPyTools owns that folder and removes stale
outputs before every upload, so it can also be inspected or deleted manually.
Protected VS Code extension storage remains an optional mode under **MPY:
Select Build Folder Location** for users who prefer to minimize workspace file
watching. **MPY: Open Build Folder** opens either location, and **MPY: Clear
Build Cache** safely resets it.

Project uploads remain incremental in both modes: unchanged sources are not
recompiled, and `mpremote` compares hashes so matching files on the device are
not transferred again.

---

## Українською

MPyTools — розширення VS Code для вибору MicroPython-пристрою, REPL, керування
файлами, компіляції `.py` у `.mpy`, завантаження проєкту та локальних знімків
прошивки.

Для першого запуску встановіть Python 3 із підтримкою `venv`, виконайте
**MPY: Install Managed Toolchain**, під'єднайте плату й оберіть
**MPY: Select Port**. Інструменти встановлюються в ізольоване сховище
розширення — системний Python і системні пакети не змінюються.

На Linux користувач зазвичай має входити до групи доступу до послідовних портів
(часто `dialout`). Після додавання до групи потрібно вийти із сеансу та зайти
знову. Для Flatpak/Snap також потрібен дозвіл на USB/serial. Команда
**MPY: Diagnostics** показує групи користувача, права порту, джерело `mpremote`,
видимі пристрої та результат безпечної перевірки підключення.

Абсолютний шлях `/dev/ttyACM0` більше не перетворюється на
`/dev//dev/ttyACM0`. Якщо плата повідомляє серійний номер, вибір зберігається за
ним, тому перепідключення або зміна номера `ttyACM*` не прив'язує розширення до
чужого пристрою.

Проміжні файли компіляції зберігаються поза робочим каталогом у сховищі VS Code,
тому інші розширення не перескановують проєкт після кожного створеного файла.
Каталоги `__pycache__`, файли `*.pyc`, віртуальні середовища, приховані каталоги
та кеші інструментів не потрапляють до прошивки. Перелік ресурсів, які можна
перетворювати на Python-модулі, задається параметром
`mpytools.wrappableAssetExtensions`; решта ресурсів копіюється без змін.
