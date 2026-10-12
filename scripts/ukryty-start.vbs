' Start workera hipokampa bez okna konsoli (zadanie Harmonogramu "hipokamp-worker", przy logowaniu).
' Harmonogram otwiera okno konsoli dla bun.exe; WScript.Shell.Run z parametrem 0 ukrywa je od pierwszej chwili.
' Użycie: wscript.exe //B //Nologo ukryty-start.vbs "<bun.exe>" "<repo>\src\cli.ts"
Option Explicit

If WScript.Arguments.Count < 2 Then WScript.Quit 2

Dim sh
Set sh = CreateObject("WScript.Shell")
sh.Run """" & WScript.Arguments(0) & """ """ & WScript.Arguments(1) & """ start", 0, False
