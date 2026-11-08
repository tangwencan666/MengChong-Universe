'use strict';
// Used only by package-installer.cjs against a reviewed staging app. No publish feed.
module.exports = {
  appId: 'com.weibiye.desktop', productName: '萌宠溜达',
  asar: true, npmRebuild: false, buildDependenciesFromSource: false,
  forceCodeSigning: false, publish: null,
  win: { target: [{ target: 'nsis', arch: ['x64'] }], icon: 'assets/app.ico', executableName: 'WeiBiYe',
    requestedExecutionLevel: 'asInvoker', verifyUpdateCodeSignature: true },
  nsis: { oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: false,
    deleteAppDataOnUninstall: false, runAfterFinish: false, createDesktopShortcut: true,
    createStartMenuShortcut: true, shortcutName: '萌宠溜达', uninstallDisplayName: '萌宠溜达（内测版）',
    installerIcon: 'assets/app.ico', uninstallerIcon: 'assets/app.ico',
    artifactName: '萌宠溜达-${version}-${arch}-setup.exe' },
};
