' Lance le dashboard "Maison" sans console, puis l'ouvre en fenetre d'application.
Option Explicit
Dim sh, fso, dir, url, edge, i
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName) & "\dashboard"
url = "http://localhost:8090"

Function Listening()
    Listening = (sh.Run("powershell -NoProfile -Command ""if (Get-NetTCPConnection -LocalPort 8090 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }""", 0, True) = 0)
End Function

If Not Listening() Then
    ' Accessible depuis le reseau (telephones du Wi-Fi), avec le code de dashboard\pin.txt ; ce PC lui-meme n'a pas de code
    Dim envp, pin, f
    Set envp = sh.Environment("Process")
    envp("MAISON_BIND") = "0.0.0.0"
    If fso.FileExists(dir & "\pin.txt") Then
        Set f = fso.OpenTextFile(dir & "\pin.txt", 1)
        pin = Trim(f.ReadLine)
        f.Close
        envp("MAISON_PIN") = pin
    Else
        envp("MAISON_BIND") = "127.0.0.1"   ' pas de code : on reste en local
    End If
    sh.CurrentDirectory = dir
    sh.Run "cmd /c node --no-deprecation server.js > server.log 2>&1", 0, False
    For i = 1 To 20
        WScript.Sleep 500
        If Listening() Then Exit For
    Next
End If

edge = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe"
If Not fso.FileExists(edge) Then edge = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe"
If fso.FileExists(edge) Then
    sh.Run """" & edge & """ --app=" & url, 1, False
Else
    sh.Run url, 1, False
End If
