import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'graceful-fs'
import { homedir, userInfo as user } from 'os'
import { parse as plistParse, PlistObject } from 'plist'

import {
  AppSettings,
  GlobalConfigVersion,
  WineInstallation
} from 'common/types'
import { LegendaryUser } from 'backend/storeManagers/legendary/user'
import {
  currentGlobalConfigVersion,
  configPath,
  defaultWinePrefix,
  gamesConfigPath,
  heroicInstallPath,
  toolsPath,
  userHome,
  isFlatpak,
  isMac,
  isWindows,
  getSteamLibraries,
  getSteamCompatFolder,
  configStore
} from './constants'
import { execAsync } from './utils'
import { execSync } from 'child_process'
import { logError, logInfo, LogPrefix } from './logger/logger'
import { dirname, join } from 'path'

/**
 * This class does config handling.
 * This can't be constructed directly. Use the static method get().
 * It automatically selects the appropriate config loader based on the config version.
 *
 * It also implements all the config features that won't change across versions.
 */
abstract class GlobalConfig {
  protected static globalInstance: GlobalConfig

  public abstract version: GlobalConfigVersion

  protected config: AppSettings | undefined

  public set(config: AppSettings) {
    this.config = config
  }

  /**
   * Get the global configuartion handler.
   * If one doesn't exist, create one.
   *
   * @returns GlobalConfig instance.
   */
  public static get(): GlobalConfig {
    let version: GlobalConfigVersion

    // Config file doesn't already exist, make one with the current version.
    if (!existsSync(configPath)) {
      version = currentGlobalConfigVersion
    }
    // Config file exists, detect its version.
    else {
      // Check version field in the config.
      try {
        version = JSON.parse(readFileSync(configPath, 'utf-8'))['version']
      } catch (error) {
        logError(
          `Config file is corrupted, please check ${configPath}`,
          LogPrefix.Backend
        )
        version = 'v0'
      }
      // Legacy config file without a version field, it's a v0 config.
      if (!version) {
        version = 'v0'
      }
    }

    if (!GlobalConfig.globalInstance) {
      GlobalConfig.reload(version)
    }

    return GlobalConfig.globalInstance
  }

  /**
   * Recreate the global configuration handler.
   *
   * @param version Config version to load file using.
   * @returns void
   */
  private static reload(version: GlobalConfigVersion): void {
    // Select loader to use.
    switch (version) {
      case 'v0':
        GlobalConfig.globalInstance = new GlobalConfigV0()
        break
      default:
        logError(
          `Invalid config version '${version}' requested.`,
          LogPrefix.GlobalConfig
        )
        break
    }
    // Try to upgrade outdated config.
    if (GlobalConfig.globalInstance.upgrade()) {
      // Upgrade done, we need to fully reload config.
      logInfo(
        `Upgraded outdated ${version} config to ${currentGlobalConfigVersion}.`,
        LogPrefix.GlobalConfig
      )
      return GlobalConfig.reload(currentGlobalConfigVersion)
    } else if (version !== currentGlobalConfigVersion) {
      // Upgrade failed.
      logError(
        `Failed to upgrade outdated ${version} config.`,
        LogPrefix.GlobalConfig
      )
    }
  }

  /**
   * Loads the default wine installation path and version.
   *
   * @returns Promise<WineInstallation>
   */
  public getDefaultWine(): WineInstallation {
    const defaultWine: WineInstallation = {
      bin: '',
      name: 'Default Wine - Not Found',
      type: 'wine'
    }

    try {
      let stdout = execSync(`which wine`).toString()
      const wineBin = stdout.split('\n')[0]
      defaultWine.bin = wineBin

      stdout = execSync(`wine --version`).toString()
      const version = stdout.split('\n')[0]
      defaultWine.name = `Wine Default - ${version}`

      return {
        ...defaultWine,
        ...this.getWineExecs(wineBin)
      }
    } catch {
      return defaultWine
    }
  }

  /**
   * Detects Wine installed on home application folder on Mac
   *
   * @returns Promise<Set<WineInstallation>>
   */
  public async getWineOnMac(): Promise<Set<WineInstallation>> {
    const wineSet = new Set<WineInstallation>()
    if (!isMac) {
      return wineSet
    }

    const winePaths = new Set<string>()

    // search for wine installed on $HOME/Library/Application Support/heroic/tools/wine
    const wineToolsPath = `${toolsPath}/wine/`
    if (existsSync(wineToolsPath)) {
      readdirSync(wineToolsPath).forEach((path) => {
        winePaths.add(join(wineToolsPath, path))
      })
    }

    // search for wine installed around the system
    await execAsync('mdfind kMDItemCFBundleIdentifier = "*.wine"').then(
      async ({ stdout }) => {
        stdout.split('\n').forEach((winePath) => {
          winePaths.add(winePath)
        })
      }
    )

    winePaths.forEach((winePath) => {
      const infoFilePath = join(winePath, 'Contents/Info.plist')
      if (winePath && existsSync(infoFilePath)) {
        const info = plistParse(
          readFileSync(infoFilePath, 'utf-8')
        ) as PlistObject
        const version = info['CFBundleShortVersionString'] || ''
        const name = info['CFBundleName'] || ''
        const wineBin = join(winePath, '/Contents/Resources/wine/bin/wine64')
        if (existsSync(wineBin)) {
          wineSet.add({
            ...this.getWineExecs(wineBin),
            lib: `${winePath}/Contents/Resources/wine/lib`,
            lib32: `${winePath}/Contents/Resources/wine/lib`,
            bin: wineBin,
            name: `${name} - ${version}`,
            type: 'wine',
            ...this.getWineExecs(wineBin)
          })
        }
      }
    })

    return wineSet
  }

  public async getWineskinWine(): Promise<Set<WineInstallation>> {
    const wineSet = new Set<WineInstallation>()
    if (!isMac) {
      return wineSet
    }
    const wineSkinPath = `${userHome}/Applications/Wineskin`
    if (existsSync(wineSkinPath)) {
      const apps = readdirSync(wineSkinPath)
      for (const app of apps) {
        if (app.includes('.app')) {
          const wineBin = `${userHome}/Applications/Wineskin/${app}/Contents/SharedSupport/wine/bin/wine64`
          if (existsSync(wineBin)) {
            try {
              const { stdout: out } = await execAsync(`'${wineBin}' --version`)
              const version = out.split('\n')[0]
              wineSet.add({
                ...this.getWineExecs(wineBin),
                lib: `${userHome}/Applications/Wineskin/${app}/Contents/SharedSupport/wine/lib`,
                lib32: `${userHome}/Applications/Wineskin/${app}/Contents/SharedSupport/wine/lib`,
                name: `Wineskin - ${version}`,
                type: 'wine',
                bin: wineBin
              })
            } catch (error) {
              logError(
                `Error getting wine version for ${wineBin}`,
                LogPrefix.GlobalConfig
              )
            }
          }
        }
      }
    }
    return wineSet
  }

  /**
   * Detects CrossOver installs on Mac
   *
   * @returns Promise<Set<WineInstallation>>
   */
  public async getCrossover(): Promise<Set<WineInstallation>> {
    const crossover = new Set<WineInstallation>()

    if (!isMac) {
      return crossover
    }

    await execAsync(
      'mdfind kMDItemCFBundleIdentifier = "com.codeweavers.CrossOver"'
    ).then(async ({ stdout }) => {
      stdout.split('\n').forEach((crossoverMacPath) => {
        const infoFilePath = join(crossoverMacPath, 'Contents/Info.plist')
        if (crossoverMacPath && existsSync(infoFilePath)) {
          const info = plistParse(
            readFileSync(infoFilePath, 'utf-8')
          ) as PlistObject
          const version = info['CFBundleShortVersionString'] || ''
          const crossoverWineBin = join(
            crossoverMacPath,
            'Contents/SharedSupport/CrossOver/bin/wine'
          )
          crossover.add({
            bin: crossoverWineBin,
            name: `CrossOver - ${version}`,
            type: 'crossover',
            ...this.getWineExecs(crossoverWineBin)
          })
        }
      })
    })
    return crossover
  }

  public async getMacOsWineSet(): Promise<Set<WineInstallation>> {
    if (!isMac) {
      return new Set<WineInstallation>()
    }

    const crossover = await this.getCrossover()
    const wineOnMac = await this.getWineOnMac()
    const wineskinWine = await this.getWineskinWine()
    return new Set([...crossover, ...wineOnMac, ...wineskinWine])
  }

  /**
   * Detects Wine/Proton on the user's system.
   *
   * @returns An Array of Wine/Proton installations.
   */
  public async getAlternativeWine(
    scanCustom = true
  ): Promise<WineInstallation[]> {
    if (isMac) {
      const macOsWineSet = await this.getMacOsWineSet()
      return [...macOsWineSet]
    }

    if (!existsSync(`${toolsPath}/wine`)) {
      mkdirSync(`${toolsPath}/wine`, { recursive: true })
    }

    if (!existsSync(`${toolsPath}/proton`)) {
      mkdirSync(`${toolsPath}/proton`, { recursive: true })
    }

    const altWine = new Set<WineInstallation>()

    readdirSync(`${toolsPath}/wine/`).forEach((version) => {
      const wineBin = join(toolsPath, 'wine', version, 'bin', 'wine')
      altWine.add({
        bin: wineBin,
        name: `Wine - ${version}`,
        type: 'wine',
        ...this.getWineLibs(wineBin),
        ...this.getWineExecs(wineBin)
      })
    })

    const lutrisPath = `${homedir()}/.local/share/lutris`
    const lutrisCompatPath = `${lutrisPath}/runners/wine/`

    if (existsSync(lutrisCompatPath)) {
      readdirSync(lutrisCompatPath).forEach((version) => {
        const wineBin = join(lutrisCompatPath, version, 'bin', 'wine')
        altWine.add({
          bin: wineBin,
          name: `Wine - ${version}`,
          type: 'wine',
          ...this.getWineLibs(wineBin),
          ...this.getWineExecs(wineBin)
        })
      })
    }

    const protonPaths = [`${toolsPath}/proton/`]

    await getSteamLibraries().then((libs) => {
      libs.forEach((path) => {
        protonPaths.push(`${path}/steam/steamapps/common`)
        protonPaths.push(`${path}/steamapps/common`)
        protonPaths.push(`${path}/root/compatibilitytools.d`)
        protonPaths.push(`${path}/compatibilitytools.d`)
        return
      })
    })

    const proton = new Set<WineInstallation>()

    protonPaths.forEach((path) => {
      if (existsSync(path)) {
        readdirSync(path).forEach((version) => {
          const protonBin = join(path, version, 'proton')
          // check if bin exists to avoid false positives
          if (existsSync(protonBin)) {
            proton.add({
              bin: protonBin,
              name: `Proton - ${version}`,
              type: 'proton'
              // No need to run this.getWineExecs here since Proton ships neither Wineboot nor Wineserver
            })
          }
        })
      }
    })

    const defaultWineSet = new Set<WineInstallation>()
    const defaultWine = await this.getDefaultWine()
    if (!defaultWine.name.includes('Not Found')) {
      defaultWineSet.add(defaultWine)
    }

    let customWineSet = new Set<WineInstallation>()
    if (scanCustom) {
      customWineSet = this.getCustomWinePaths()
    }

    return [...defaultWineSet, ...altWine, ...proton, ...customWineSet]
  }

  /**
   * Checks if a Wine version has Wineboot/Wineserver executables and returns the path to those if they're present
   * @param wineBin The unquoted path to the Wine binary ('wine')
   * @returns The quoted paths to wineboot and wineserver, if present
   */
  public getWineExecs(wineBin: string): {
    wineboot: string
    wineserver: string
  } {
    const wineDir = dirname(wineBin)
    const ret = { wineserver: '', wineboot: '' }
    const potWineserverPath = join(wineDir, 'wineserver')
    if (existsSync(potWineserverPath)) {
      ret.wineserver = potWineserverPath
    }
    const potWinebootPath = join(wineDir, 'wineboot')
    if (existsSync(potWinebootPath)) {
      ret.wineboot = potWinebootPath
    }
    return ret
  }

  /**
   * Checks if a Wine version has lib/lib32 folders and returns the path to those if they're present
   * @param wineBin The unquoted path to the Wine binary ('wine')
   * @returns The paths to lib and lib32, if present
   */
  public getWineLibs(wineBin: string): {
    lib: string
    lib32: string
  } {
    const wineDir = dirname(wineBin)
    const ret = { lib: '', lib32: '' }
    const potLib32Path = join(wineDir, '../lib')
    if (existsSync(potLib32Path)) {
      ret.lib32 = potLib32Path
    }
    const potLibPath = join(wineDir, '../lib64')
    if (existsSync(potLibPath)) {
      ret.lib = potLibPath
    }
    return ret
  }

  /**
   * Gets the actual settings from the config file.
   * Does not modify its parent object.
   * Always reads from file regardless of `this.config`.
   *
   * @returns Settings present in config file.
   */
  public abstract getSettings(): AppSettings

  /**
   * Updates this.config, this.version to upgrade the current config file.
   *
   * Writes to file after that.
   * DO NOT call `flush()` afterward.
   *
   * @returns true if upgrade successful if upgrade fails or no upgrade needed.
   */
  public abstract upgrade(): boolean

  /**
   * Get custom Wine installations as defined in the config file.
   *
   * @returns Set of Wine installations.
   */
  public abstract getCustomWinePaths(): Set<WineInstallation>

  /**
   * Get default settings as if the user's config file doesn't exist.
   * Doesn't modify the parent object.
   * Doesn't access config files.
   *
   * @returns AppSettings
   */
  public abstract getFactoryDefaults(): AppSettings

  /**
   * Reset `this.config` to `getFactoryDefaults()` and flush.
   */
  public abstract resetToDefaults(): void

  protected writeToFile(config: Record<string, unknown>) {
    return writeFileSync(configPath, JSON.stringify(config, null, 2))
  }

  /**
   * Write `this.config` to file.
   * Uses the config version defined in `this.version`.
   */
  public abstract flush(): void

  /** change a specific setting */
  public abstract setSetting(key: string, value: unknown): void

  /**
   * Load the config file, upgrade if needed.
   */
  protected load() {
    // Config file doesn't exist, make one.
    if (!existsSync(configPath)) {
      this.resetToDefaults()
    }
    // Always upgrade before loading to avoid errors.
    // `getSettings` doesn't return an `AppSettings` otherwise.
    if (this.version !== currentGlobalConfigVersion) {
      // Do not load the config.
      // Wait for `upgrade` to be called by `reload`.
    } else {
      // No upgrades necessary, load config.
      // `this.version` should be `currentGlobalConfigVersion` at this point.
      this.config = this.getSettings()
    }
  }
}

class GlobalConfigV0 extends GlobalConfig {
  public version: GlobalConfigVersion = 'v0'

  constructor() {
    super()
    this.load()
  }

  public upgrade() {
    // Here we rewrite the config object to match the latest format and write to file.
    // Not necessary as this is the current version.
    return false
  }

  public getSettings(): AppSettings {
    if (this.config) {
      return this.config
    }

    if (!existsSync(gamesConfigPath)) {
      mkdirSync(gamesConfigPath, { recursive: true })
    }

    if (!existsSync(configPath)) {
      return this.getFactoryDefaults()
    }

    let settings = JSON.parse(readFileSync(configPath, 'utf-8'))
    const defaultSettings = settings.defaultSettings as AppSettings

    // fix relative paths
    const winePrefix = !isWindows
      ? defaultSettings?.winePrefix?.replace('~', userHome)
      : ''

    settings = {
      ...this.getFactoryDefaults(),
      ...settings.defaultSettings,
      winePrefix
    } as AppSettings

    // TODO: Remove this after a couple of stable releases
    // Get settings only from config-store
    const currentConfigStore = configStore.get_nodefault('settings')
    if (!currentConfigStore?.defaultInstallPath) {
      configStore.set('settings', settings)
    }

    return settings
  }

  public getCustomWinePaths(): Set<WineInstallation> {
    const customPaths = new Set<WineInstallation>()
    // skips this on new installations to avoid infinite loops
    if (existsSync(configPath)) {
      const { customWinePaths = [] } = this.getSettings()
      customWinePaths.forEach((path: string) => {
        if (path.endsWith('proton')) {
          return customPaths.add({
            bin: path,
            name: `Custom Proton - ${path}`,
            type: 'proton'
          })
        }
        return customPaths.add({
          bin: path,
          name: `Custom Wine - ${path}`,
          type: 'wine',
          ...this.getWineExecs(path)
        })
      })
    }
    return customPaths
  }

  public getFactoryDefaults(): AppSettings {
    const account_id = LegendaryUser.getUserInfo()?.account_id
    const userName = user().username
    const defaultWine = isWindows ? {} : this.getDefaultWine()

    // @ts-expect-error TODO: We need to settle on *one* place to define settings defaults
    return {
      checkUpdatesInterval: 10,
      enableUpdates: false,
      addDesktopShortcuts: false,
      addStartMenuShortcuts: false,
      autoInstallDxvk: true,
      autoInstallVkd3d: true,
      addSteamShortcuts: false,
      preferSystemLibs: false,
      checkForUpdatesOnStartup: !isFlatpak,
      autoUpdateGames: false,
      customWinePaths: isWindows ? null : [],
      defaultInstallPath: heroicInstallPath,
      libraryTopSection: 'disabled',
      defaultSteamPath: getSteamCompatFolder(),
      defaultWinePrefix: defaultWinePrefix,
      hideChangelogsOnStartup: false,
      language: 'en',
      maxWorkers: 0,
      minimizeOnLaunch: false,
      nvidiaPrime: false,
      enviromentOptions: [],
      wrapperOptions: [],
      showFps: false,
      useGameMode: false,
      userInfo: {
        epicId: account_id,
        name: userName
      },
      wineCrossoverBottle: 'Heroic',
      winePrefix: isWindows ? '' : defaultWinePrefix,
      wineVersion: defaultWine
    } as AppSettings
  }

  public setSetting(key: string, value: unknown) {
    const config = this.getSettings()
    const configStoreSettings = configStore.get_nodefault('settings') || config
    configStore.set('settings', { ...configStoreSettings, [key]: value })
    config[key] = value
    this.config = config
    logInfo(`Heroic: Setting ${key} to ${JSON.stringify(value)}`)
    return this.flush()
  }

  public resetToDefaults() {
    this.config = this.getFactoryDefaults()
    return this.flush()
  }

  public flush() {
    return this.writeToFile({
      defaultSettings: this.config,
      version: 'v0'
    })
  }
}

export { GlobalConfig }
