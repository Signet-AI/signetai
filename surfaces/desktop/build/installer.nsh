!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Classes\signet" "" "URL:Signet Protocol"
  WriteRegStr SHELL_CONTEXT "Software\Classes\signet" "URL Protocol" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\signet\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\signet\shell\open\command" "" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\""
!macroend

!macro customUnInstall
  ReadRegStr $0 SHELL_CONTEXT "Software\Classes\signet\shell\open\command" ""
  StrCmp $0 "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\"" 0 done
  DeleteRegKey SHELL_CONTEXT "Software\Classes\signet"
  done:
!macroend
