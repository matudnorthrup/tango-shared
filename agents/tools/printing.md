# 3D Printing Tools

Shared doc for `printer_command`, `openscad_render`, and `prusa_slice`.

## `printer_command`

Prusa MK4 management through the PrusaLink API.

Input:

```json
{
  "action": "status"
}
```

Supported actions:
- `status`
- `job`
- `upload` with `file_path`
- `start` with printer-side `file_path`
- `stop` with `job_id`

Preview mode:
- pass `"dry_run": true` with `upload`, `start`, or `stop` to preview the action without changing the printer

Returns parsed API JSON or an `error`.

## `openscad_render`

Render a `.scad` file to `.stl`.

Input:

```json
{
  "input_file": "~/3d-printing/gridfinity/src/bin.scad",
  "output_file": "~/3d-printing/gridfinity/stl/bin.stl",
  "parameters": {
    "gridx": 3,
    "gridy": 2
  }
}
```

Returns:
- `success`
- `output`
- `log`

## `prusa_slice`

Slice `.stl` to `.gcode` with PrusaSlicer.

Input:

```json
{
  "input_file": "/absolute/path/to/gridfinity/stl/bin.stl",
  "output_file": "/absolute/path/to/gridfinity/gcode/bin.gcode",
  "print_profile": "0.20mm SPEED @MK4IS 0.4",
  "material_profile": "Generic PLA @PGIS",
  "infill": 5
}
```

Notes:
- Prefer absolute paths for `input_file` and `output_file`. In some environments the tool may not expand `~`.
- Common valid print profiles include `0.10mm FAST DETAIL`, `0.15mm SPEED`, `0.20mm SPEED @MK4IS 0.4`, and `0.20mm STRUCTURAL`.
- Common valid material profiles include `Generic PLA @PGIS`, `Generic PETG @PGIS`, and `Prusament PLA @PGIS`.
- The slicer tool truncates long comment lines after slicing to avoid MK4 buffer issues.
- Profile-selection guidance lives in `agents/skills/printing-profile-selection.md`.

### ⚠️ PrusaSlicer 2.9.4 CLI — MK4 Profile Inheritance Bug

**Problem:** PrusaSlicer 2.9.4 CLI cannot resolve vendor bundle profile inheritance for MK4 profiles. The `--printer-profile` flag silently falls back to `- default FFF -`, producing generic G-code without `M862.x` printer validation blocks. The MK4 firmware rejects this with a "G-code isn't compatible" error.

**Fix:** Use a pre-resolved flat INI file instead of relying on `--printer-profile`. A resolved profile already exists at:

```
~/3d-printing/opengrid/mk4is_profile.ini
```

Pass it via `--load` when invoking PrusaSlicer CLI directly. The `prusa_slice` tool handles this automatically — but if you're calling PrusaSlicer manually, do **not** use `--printer-profile` alone.

**Verification:** After slicing, confirm the G-code contains the MK4 validation block from the resolved profile before uploading. In this workspace that block is 4 lines: `M862.1`, `M862.3`, `M862.5`, and `M862.6`. If those lines are missing, the print will fail at the printer.

**Post-slice comment truncation:** Always run after slicing to prevent MK4 buffer overflow:
```bash
sed -i '' 's/^\(.\{250\}\).*/\1/' output.gcode
```
