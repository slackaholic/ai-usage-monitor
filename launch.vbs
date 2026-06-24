Set objShell = CreateObject("WScript.Shell")
objShell.CurrentDirectory = "C:\Users\Rommel Payba\.claude\sessions\ai-usage-monitor"
objShell.Run "npm start", 0, False
