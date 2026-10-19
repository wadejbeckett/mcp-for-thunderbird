# Install

To be written in Task 22

## Upgrading from a versioned folder

Thunderbird finds the host through the full path of the program, recorded when you run `mcp-for-thunderbird setup`. If you install the program through a package manager that keeps each version in its own folder (Homebrew keeps it under `Cellar/mcp-for-thunderbird/<version>/`), run `mcp-for-thunderbird setup` again after every upgrade, so the recorded path points to the new version. The Windows installer, the macOS package and the `.deb` install to a fixed folder and need nothing extra.
