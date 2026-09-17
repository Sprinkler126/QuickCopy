' ============================================================
'  QuickCopy - double-click me to start.
'
'  Runs tray.ps1 through PowerShell with a hidden window, so you
'  get no console flash; the app shows up as a tray icon instead.
'  Keep this file ASCII-only (wscript reads .vbs as ANSI text).
' ============================================================

Option Explicit

Dim shell, fso, baseDir, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = baseDir

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ _
    & baseDir & "\tray.ps1"""

' 0 = hidden window, False = do not wait for it to finish
shell.Run cmd, 0, False
