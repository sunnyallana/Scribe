; NSIS hooks invoked by Tauri 2's installer template.
;
; The macros below run at fixed points in the install flow. Only
; `NSIS_HOOK_POSTINSTALL` is wired today; pre-install / pre-uninstall
; etc. are no-ops and Tauri's bundler will skip them silently.
;
; The post-install step makes sure the machine has a working LaTeX
; engine. The desktop app's `resolve_engine` prefers latexmk →
; pdflatex → tectonic; tectonic is bundled with the installer (lives
; under `<install>/resources/tectonic.exe`) so even a fresh machine
; has a working fallback. We *also* offer MiKTeX via winget here
; because pdflatex-with-multi-pass-citations stays the better
; default when present.

; ---------------------------------------------------------------------------
; MUI bitmap defines. Tauri's NSIS template `!include`s this file
; BEFORE inserting the MUI page macros, so these defines take effect
; for the welcome / finish / header bitmaps it sets up. Without
; `_NOSTRETCH` NSIS scales the 164x314 sidebar BMP up to the welcome
; dialog's full size — that's what caused the giant S filling the
; whole window in the earlier build. `_RIGHT` keeps the header image
; flush with the right edge where NSIS's own page title doesn't
; overlap it.
!ifndef MUI_HEADERIMAGE_BITMAP_NOSTRETCH
  !define MUI_HEADERIMAGE_BITMAP_NOSTRETCH
!endif
!ifndef MUI_HEADERIMAGE_RIGHT
  !define MUI_HEADERIMAGE_RIGHT
!endif
!ifndef MUI_WELCOMEFINISHPAGE_BITMAP_NOSTRETCH
  !define MUI_WELCOMEFINISHPAGE_BITMAP_NOSTRETCH
!endif
!ifndef MUI_UNWELCOMEFINISHPAGE_BITMAP_NOSTRETCH
  !define MUI_UNWELCOMEFINISHPAGE_BITMAP_NOSTRETCH
!endif

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Checking for an existing LaTeX engine on PATH..."
  ; `where` returns 0 when the command is found, non-zero otherwise.
  nsExec::ExecToStack 'where pdflatex'
  Pop $0
  StrCmp $0 "0" miktex_present miktex_missing

  miktex_missing:
    DetailPrint "pdflatex not found on PATH."
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "Scribe ships with a built-in LaTeX engine (tectonic), but MiKTeX provides a faster pdflatex pipeline.$\r$\n$\r$\nInstall MiKTeX now via winget?" \
      /SD IDNO IDYES install_miktex IDNO miktex_skipped
    install_miktex:
      DetailPrint "Installing MiKTeX via winget (this can take a few minutes)..."
      nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "winget install --id MiKTeX.MiKTeX --silent --accept-source-agreements --accept-package-agreements"'
      Pop $1
      StrCmp $1 "0" miktex_installed miktex_install_failed
      miktex_installed:
        DetailPrint "MiKTeX installed."
        ; MiKTeX's latexmk.exe is a Perl-script wrapper — without Perl
        ; on PATH every latexmk invocation fails with "could not find
        ; the script engine 'perl'". Pair the MiKTeX install with
        ; Strawberry Perl so the user lands on a working pdflatex +
        ; latexmk pipeline rather than an installed-but-broken one.
        DetailPrint "Installing Strawberry Perl (required by MiKTeX's latexmk)..."
        nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "winget install --id StrawberryPerl.StrawberryPerl --silent --accept-source-agreements --accept-package-agreements"'
        Pop $2
        StrCmp $2 "0" perl_installed perl_install_failed
        perl_installed:
          DetailPrint "Strawberry Perl installed."
          Goto miktex_done
        perl_install_failed:
          DetailPrint "Strawberry Perl install via winget did not complete cleanly (exit $2). latexmk will be skipped until Perl is on PATH; the bundled tectonic remains as fallback."
          Goto miktex_done
      miktex_install_failed:
        DetailPrint "MiKTeX install via winget did not complete cleanly (exit $1). The bundled tectonic engine is still available."
        Goto miktex_done
    miktex_skipped:
      DetailPrint "Skipped MiKTeX install. Falling back to the bundled tectonic engine."
      Goto miktex_done

  miktex_present:
    DetailPrint "pdflatex already on PATH — skipping MiKTeX install."
    Goto miktex_done

  miktex_done:
    DetailPrint "Prerequisites and post-install notes: $INSTDIR\resources\PREREQUISITES.md"
    DetailPrint "Local data lives in $LOCALAPPDATA\io.scribe.desktop (created on first launch)."
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; The app stores its SQLite mirror + tectonic workdirs under
  ; $LOCALAPPDATA\io.scribe.desktop\. Ask before nuking — users
  ; reinstalling an upgrade almost always want to keep their
  ; projects. Silent uninstalls (`/S`) default to keep.
  IfFileExists "$LOCALAPPDATA\io.scribe.desktop\*.*" data_present data_absent
  data_present:
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "Remove your local Scribe data ($LOCALAPPDATA\io.scribe.desktop)?$\r$\n$\r$\nThis deletes the offline SQLite mirror, compile workdirs, and any cached PDFs. Choose No to keep them for a re-install or rollback." \
      /SD IDNO IDYES wipe_data IDNO keep_data
    wipe_data:
      DetailPrint "Removing local Scribe data..."
      RMDir /r "$LOCALAPPDATA\io.scribe.desktop"
      Goto data_done
    keep_data:
      DetailPrint "Preserved local Scribe data."
      Goto data_done
  data_absent:
    DetailPrint "No local Scribe data to clean up."
  data_done:
!macroend
