' ============================================================
'  QuickCopy - double-click me to start.
'
'  Runs tray.ps1 through PowerShell with a hidden window, so you
'  get no console flash; the app shows up as a tray icon instead.
'  Keep this file ASCII-only (wscript reads .vbs as ANSI text).
' ============================================================

Option Explicit

' ------------------------------------------------------------
'  Startup settings - just edit these two lines.
'
'  PORT   : port the local service listens on.
'  CONFIG : default config file handed to the server, relative to
'           this folder. Browsers read it once on their first visit
'           and then keep their own copy in localStorage.
'             "data\resume.example.json" -> safe default (placeholder data)
'             "data\resume.json"         -> your own real data
'           NOTE: the server now listens on all interfaces, so whatever
'           this points at can be read by anyone on the same LAN.
' ------------------------------------------------------------
Dim PORT, CONFIG
PORT = 18437
CONFIG = "data\resume.example.json"

Dim shell, fso, baseDir, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = baseDir

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ _
    & baseDir & "\tray.ps1"" -Port " & PORT & " -ConfigFile """ & CONFIG & """"

' 0 = hidden window, False = do not wait for it to finish
shell.Run cmd, 0, False
