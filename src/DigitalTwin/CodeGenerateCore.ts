// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import * as os from 'os';
import * as vscode from 'vscode';
import * as fs from 'fs-plus';
import * as path from 'path';
import * as crypto from 'crypto';

import request = require('request-promise');
import {FileNames, ConfigKey} from '../constants';
import {TelemetryContext} from '../telemetry';
import {DigitalTwinConnector} from './DigitalTwinConnector';
import {DigitalTwinConstants, CodeGenConstants} from './DigitalTwinConstants';
import {CodeGenProjectType, DeviceConnectionType} from './DigitalTwinCodeGen/Interfaces/CodeGenerator';
import {AnsiCCodeGeneratorFactory} from './DigitalTwinCodeGen/AnsiCCodeGeneratorFactory';
import {ConfigHandler} from '../configHandler';
import extractzip = require('extract-zip');
import * as utils from '../utils';
import {DigitalTwinMetamodelRepositoryClient} from './DigitalTwinApi/DigitalTwinMetamodelRepositoryClient';
import {DigitalTwinConnectionStringBuilder} from './DigitalTwinApi/DigitalTwinConnectionStringBuilder';

const constants = {
  idName: '@id',
  schemaFolderName: 'schema'
};

interface CodeGeneratorDownloadLocation {
  win32Md5: string;
  win32PackageUrl: string;
  macOSMd5: string;
  macOSPackageUrl: string;
  ubuntuMd5: string;
  ubuntuPackageUrl: string;
}

interface InterfaceInfo {
  urnId: string;
  path: string;
}

const deviceConnectionConstants = {
  connectionStringLabel: 'Via IoT Hub device connection string',
  connectionStringDetail: 'To connect to Azure IoT Hub directly',
  iotcSasKeyLabel: 'Via DPS (Device Provision Service) symmetric key',
  iotcSasKeyDetail:
      'To connect to Azure IoT Hub, Azure IoT Central or Azure IoT Certification Service'
};

interface CodeGeneratorConfigItem {
  codeGeneratorVersion: string;
  iotWorkbenchMinimalVersion: string;
  codeGeneratorLocation: CodeGeneratorDownloadLocation;
}

interface CodeGeneratorConfig {
  codeGeneratorConfigItems: CodeGeneratorConfigItem[];
}

interface CodeGenExecutionInfo {
  schemaFolder: string;
  targetFolder: string;
  languageLabel: string;
  codeGenProjectType: CodeGenProjectType;
  deviceConnectionType: DeviceConnectionType;
}

export class CodeGenerateCore {
  async GenerateDeviceCodeStub(
      context: vscode.ExtensionContext, channel: vscode.OutputChannel,
      telemetryContext: TelemetryContext): Promise<boolean> {
    const upgradestate: boolean =
        await this.UpgradeCodeGenerator(context, channel);
    channel.show();
    if (!upgradestate) {
      channel.appendLine(`${
          DigitalTwinConstants
              .dtPrefix} Unable to upgrade the Code Generator to the latest version.\r\n Trying to use the existing version.`);
    }

    if (!vscode.workspace.workspaceFolders) {
      return false;
    }

    const rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
    if (!rootPath) {
      const message =
          'Unable to find the folder for device model files. Please select a folder first';
      vscode.window.showWarningMessage(message);
      return false;
    }

    // list all capability models from device model folder for selection.
    const metamodelItems: vscode.QuickPickItem[] = [];
    const interfaceItems: InterfaceInfo[] = [];

    const fileList = fs.listTreeSync(rootPath);
    if (fileList && fileList.length > 0) {
      fileList.forEach((filePath: string) => {
        if (!fs.isDirectorySync(filePath)) {
          const fileName = path.basename(filePath);
          if (fileName.endsWith(DigitalTwinConstants.capabilityModelSuffix)) {
            metamodelItems.push(
                {label: fileName, description: path.dirname(filePath)});
          } else if (fileName.endsWith(DigitalTwinConstants.interfaceSuffix)) {
            let urnId;
            try {
              const fileJson = JSON.parse(fs.readFileSync(filePath, 'utf8'));
              urnId = fileJson[constants.idName];
            } catch {
            }
            if (urnId) interfaceItems.push({path: filePath, urnId});
          }
        }
      });
    }

    if (metamodelItems.length === 0) {
      const message =
          'Unable to find capability model files in the folder. Please open a folder that contains capability model files.';
      vscode.window.showWarningMessage(message);
      return false;
    }

    const fileSelection = await vscode.window.showQuickPick(metamodelItems, {
      ignoreFocusOut: true,
      matchOnDescription: true,
      matchOnDetail: true,
      placeHolder:
          `Select a ${DigitalTwinConstants.productName} capability model file`
    });

    if (!fileSelection) {
      return false;
    }

    const capbilityModelFileName = fileSelection.label;
    const selectedFilePath =
        path.join(fileSelection.description as string, capbilityModelFileName);

    // select the folder for code gen
    const folderPath = await utils.selectWorkspaceItem(
        'Please select a folder to contain your generated code:', {
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          defaultUri: vscode.workspace.workspaceFolders &&
                  vscode.workspace.workspaceFolders.length > 0 ?
              vscode.workspace.workspaceFolders[0].uri :
              undefined,
          openLabel: 'Select'
        });

    if (!folderPath) {
      throw new Error('User cancelled folder selection.');
    }

    channel.appendLine(`${DigitalTwinConstants.dtPrefix} Folder ${
        folderPath} is selected for the generated code.`);

    // select the target of the code stub
    const languageItems: vscode.QuickPickItem[] =
        [{label: 'ANSI C', description: ''}];
    const languageSelection = await vscode.window.showQuickPick(
        languageItems,
        {ignoreFocusOut: true, placeHolder: 'Please select a language:'});

    if (!languageSelection) {
      return false;
    }

    let targetItems: vscode.QuickPickItem[]|null = null;

    if (languageSelection.label === 'ANSI C') {
      targetItems = [
        {
          label: 'CMake Project',
          detail:
              'Generate device agnostic standard ANSI C code to integrate into existing device project.'
        },
        {
          label: 'Visual Studio Project',
          detail:
              'Generate device agnostic standard ANSI C code for Visual Studio project.'
        },
        {
          label: 'MXChip IoT DevKit Project',
          detail: 'Generate Arduino project for MXChip IoT DevKit'
        }
      ];
    }

    if (!targetItems) {
      return false;
    }

    const targetSelection = await vscode.window.showQuickPick(
        targetItems,
        {ignoreFocusOut: true, placeHolder: 'Please select a target:'});

    if (!targetSelection) {
      return false;
    }

    let codeGenProjectType = CodeGenProjectType.CMake;
    if (targetSelection.label === 'MXChip IoT DevKit Project') {
      codeGenProjectType = CodeGenProjectType.IoTDevKit;
    } else if (targetSelection.label === 'Visual Studio Project') {
      codeGenProjectType = CodeGenProjectType.VisualStudio;
    }

    let connectionType = DeviceConnectionType.DeviceConnectionString;
    let deviceConnectionSelections: vscode.QuickPickItem[]|null = null;
    deviceConnectionSelections = [
      {
        label: deviceConnectionConstants.connectionStringLabel,
        detail: deviceConnectionConstants.connectionStringDetail
      },
      {
        label: deviceConnectionConstants.iotcSasKeyLabel,
        detail: deviceConnectionConstants.iotcSasKeyDetail
      }
    ];

    const deviceConnectionSelection =
        await vscode.window.showQuickPick(deviceConnectionSelections, {
          ignoreFocusOut: true,
          placeHolder:
              'Please specify how will the device connect to Azure IoT?'
        });

    if (!deviceConnectionSelection) {
      return false;
    }

    if (deviceConnectionSelection.label ===
        deviceConnectionConstants.connectionStringLabel) {
      connectionType = DeviceConnectionType.DeviceConnectionString;
    } else if (
        deviceConnectionSelection.label ===
        deviceConnectionConstants.iotcSasKeyLabel) {
      connectionType = DeviceConnectionType.IoTCSasKey;
    }

    const schemaTargetFolder =
        path.join(folderPath, constants.schemaFolderName);

    utils.mkdirRecursivelySync(schemaTargetFolder);
    fs.copyFileSync(
        selectedFilePath,
        path.join(schemaTargetFolder, capbilityModelFileName));

    // Parse the cabability model
    const capabilityModel =
        JSON.parse(fs.readFileSync(selectedFilePath, 'utf8'));

    const implementedInterfaces = capabilityModel['implements'];
    for (const interfaceItem of implementedInterfaces) {
      const schema = interfaceItem.schema;
      if (typeof schema === 'string') {
        // normal interface, check the interface file offline and online
        const item = interfaceItems.find(item => item.urnId === schema);
        if (item) {
          // copy interface to the schema folder
          const interfaceName = path.basename(item.path);
          fs.copyFileSync(
              item.path, path.join(schemaTargetFolder, interfaceName));
          channel.appendLine(
              `${DigitalTwinConstants.dtPrefix} Copy ${interfaceName} with id ${
                  item.urnId} into ${schemaTargetFolder} completed.`);
        } else {
          const result = await this.DownloadInterfaceFile(
              schema, schemaTargetFolder, channel);
          if (!result) {
            const message = `Unable to get the interface with Id ${
                schema} online. Please make sure the file exists in server.`;
            channel.appendLine(`${DigitalTwinConstants.dtPrefix} ${message}`);
            vscode.window.showWarningMessage(message);
            return false;
          }
        }
      }
    }

    const codeGenExecutionInfo: CodeGenExecutionInfo = {
      schemaFolder: constants.schemaFolderName,
      targetFolder: folderPath,
      languageLabel: 'ANSI C',
      codeGenProjectType,
      deviceConnectionType: connectionType
    };

    const executionResult = await this.GenerateDeviceCodeCore(
        path.join(schemaTargetFolder, capbilityModelFileName),
        codeGenExecutionInfo, context, channel, telemetryContext);
    await ConfigHandler.update(
        ConfigKey.codeGeneratorExecutionInfo,
        JSON.stringify(codeGenExecutionInfo),
        vscode.ConfigurationTarget.Workspace);
    return executionResult;
  }

  async GenerateDeviceCodeCore(
      capabilityModelFilePath: string,
      codeGenExecutionInfo: CodeGenExecutionInfo,
      context: vscode.ExtensionContext, channel: vscode.OutputChannel,
      telemetryContext: TelemetryContext): Promise<boolean> {
    // We only support Ansi C
    const codeGenFactory =
        new AnsiCCodeGeneratorFactory(context, channel, telemetryContext);

    const codeGenerator = codeGenFactory.CreateCodeGeneratorImpl(
        codeGenExecutionInfo.codeGenProjectType,
        codeGenExecutionInfo.deviceConnectionType);
    if (!codeGenerator) {
      return false;
    }

    const fileName = path.basename(capabilityModelFilePath);
    const matchItems = fileName.match(/^(.*?)\.(capabilitymodel)\.json$/);

    if (!matchItems || !matchItems[1]) {
      return false;
    }
    const fileCoreName = matchItems[1];

    await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Generate code stub for ${fileCoreName} ...`
        },
        async () => {
          const result = await codeGenerator.GenerateCode(
              codeGenExecutionInfo.targetFolder, capabilityModelFilePath,
              fileCoreName,
              path.join(
                  codeGenExecutionInfo.targetFolder,
                  codeGenExecutionInfo.schemaFolder));
          if (result) {
            vscode.window.showInformationMessage(
                `Generate code stub for ${fileName} completed`);
          }
        });
    return true;
  }

  async DownloadInterfaceFile(
      urnId: string, targetFolder: string,
      channel: vscode.OutputChannel): Promise<boolean> {
    const fileName =
        utils.generateInterfaceFileNameFromUrnId(urnId, targetFolder);
    // Get the connection string of the IoT Plug and Play repo
    let connectionString =
        ConfigHandler.get<string>(ConfigKey.modelRepositoryKeyName);

    if (!connectionString) {
      const option: vscode.InputBoxOptions = {
        value: DigitalTwinConstants.repoConnectionStringTemplate,
        prompt:
            `Please input the connection string to access the model repository.`,
        ignoreFocusOut: true
      };

      connectionString = await vscode.window.showInputBox(option);
    }
    if (!connectionString) {
      return false;
    } else {
      const result = await DigitalTwinConnector.ConnectMetamodelRepository(
          connectionString);
      if (!result) {
        return false;
      }
      // Try to download interface file from private repo
      const dtMetamodelRepositoryClient =
          new DigitalTwinMetamodelRepositoryClient(connectionString);
      const builder =
          DigitalTwinConnectionStringBuilder.Create(connectionString);
      const repositoryId = builder.RepositoryIdValue;

      // Try to download interface file from private repo
      try {
        const fileMetaData =
            await dtMetamodelRepositoryClient.GetInterfaceAsync(
                urnId, repositoryId, true);
        if (fileMetaData) {
          fs.writeFileSync(
              path.join(targetFolder, fileName),
              JSON.stringify(fileMetaData.content, null, 4));
          channel.appendLine(
              `${DigitalTwinConstants.dtPrefix} Download interface with id ${
                  urnId}, name: ${fileName} into ${targetFolder} completed.`);
          return true;
        }
      } catch (error) {
        // Do nothing. Try to download the interface from global repo
      }

      // Try to download interface file from public repo
      try {
        const fileMetaData =
            await dtMetamodelRepositoryClient.GetInterfaceAsync(
                urnId, undefined, true);
        if (fileMetaData) {
          fs.writeFileSync(
              path.join(targetFolder, fileName),
              JSON.stringify(fileMetaData.content, null, 4));
          channel.appendLine(
              `${DigitalTwinConstants.dtPrefix} Download interface with id ${
                  urnId}, name: ${fileName} from global repository into ${
                  targetFolder} completed.`);
          return true;
        }
      } catch (error) {
      }
    }
    return false;
  }

  async UpgradeCodeGenerator(
      context: vscode.ExtensionContext,
      channel: vscode.OutputChannel): Promise<boolean> {
    channel.show();

    const extensionPackage = require(context.asAbsolutePath('./package.json'));
    const extensionVersion = extensionPackage.version;

    // download the config file for code generator
    const options: request.OptionsWithUri = {
      method: 'GET',
      uri: extensionPackage.codeGenConfigUrl,
      encoding: 'utf8',
      json: true
    };

    let targetConfigItem: CodeGeneratorConfigItem|null = null;

    const codeGenConfig: CodeGeneratorConfig = await request(options).promise();
    if (codeGenConfig) {
      codeGenConfig.codeGeneratorConfigItems.sort(
          (configItem1, configItem2) => {
            return compareVersion(
                configItem2.codeGeneratorVersion,
                configItem1.codeGeneratorVersion);  // reverse order
          });

      // if this is a RC build, always use the latest version of code generator.
      if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(extensionVersion)) {
        targetConfigItem = codeGenConfig.codeGeneratorConfigItems[0];
      } else {
        for (const item of codeGenConfig.codeGeneratorConfigItems) {
          if (compareVersion(
                  extensionVersion, item.iotWorkbenchMinimalVersion) >= 0) {
            targetConfigItem = item;
            break;
          }
        }
      }
    }

    if (!targetConfigItem) {
      channel.appendLine(`Unable to get the updated version the ${
          DigitalTwinConstants.productName} Code Generator.`);
      return false;
    }

    // detect version for upgrade
    let needUpgrade = false;
    const platform = os.platform();
    const homeDir = os.homedir();

    const codeGenCommandPath =
        path.join(homeDir, CodeGenConstants.codeGeneratorToolPath);

    // Can we find the target dir for Code Generator?
    if (!fs.isDirectorySync(codeGenCommandPath)) {
      needUpgrade = true;
    } else {
      // Then check the version
      const currentVersion =
          ConfigHandler.get<string>(ConfigKey.codeGeneratorVersion);
      if (!currentVersion ||
          compareVersion(
              targetConfigItem.codeGeneratorVersion, currentVersion) > 0) {
        needUpgrade = true;
      }
    }

    if (needUpgrade) {
      await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title:
                `Upgrade  ${DigitalTwinConstants.productName} Code Generator...`
          },
          async () => {
            channel.appendLine(`Start upgrading ${
                DigitalTwinConstants.productName} Code Generator...`);

            const configItem = targetConfigItem as CodeGeneratorConfigItem;
            let downloadOption: request.OptionsWithUri;
            let md5value: string;
            if (platform === 'win32') {
              downloadOption = {
                method: 'GET',
                uri: configItem.codeGeneratorLocation.win32PackageUrl,
                encoding: null  // Binary data
              };
              md5value = configItem.codeGeneratorLocation.win32Md5;
            } else if (platform === 'darwin') {
              downloadOption = {
                method: 'GET',
                uri: configItem.codeGeneratorLocation.macOSPackageUrl,
                encoding: null  // Binary data
              };
              md5value = configItem.codeGeneratorLocation.macOSMd5;
            } else {
              downloadOption = {
                method: 'GET',
                uri: configItem.codeGeneratorLocation.ubuntuPackageUrl,
                encoding: null  // Binary data
              };
              md5value = configItem.codeGeneratorLocation.ubuntuMd5;
            }

            const loading = setInterval(() => {
              channel.append('.');
            }, 1000);

            try {
              channel.appendLine(`Step 1: Downloading package for ${
                  DigitalTwinConstants.productName} Code Generator...`);
              const zipData = await request(downloadOption).promise();
              const tempPath =
                  path.join(os.tmpdir(), FileNames.iotworkbenchTempFolder);
              const filePath = path.join(tempPath, `${md5value}.zip`);
              fs.writeFileSync(filePath, zipData);
              clearInterval(loading);
              channel.appendLine('Download complete');

              // Validate hash code
              channel.appendLine(
                  'Step 2: Validating hash code for the package...');

              const hashvalue = await fileHash(filePath);
              if (hashvalue !== md5value) {
                throw new Error('Validating hash code failed.');
              } else {
                channel.appendLine('Validating hash code successfully.');
              }

              channel.appendLine(`Step 3: Extracting Azure IoT ${
                  DigitalTwinConstants.productName} Code Generator.`);

              await extract(filePath, codeGenCommandPath);
              channel.appendLine(`${
                  DigitalTwinConstants
                      .productName} Code Generator updated successfully.`);
              await ConfigHandler.update(
                  ConfigKey.codeGeneratorVersion,
                  configItem.codeGeneratorVersion,
                  vscode.ConfigurationTarget.Global);
            } catch (error) {
              clearInterval(loading);
              channel.appendLine('');
              throw error;
            }
          });
      vscode.window.showInformationMessage(`${
          DigitalTwinConstants
              .productName} Code Generator updated successfully`);
    }
    // No need to upgrade
    return true;
  }
}

function compareVersion(verion1: string, verion2: string) {
  const ver1 = verion1.split('.');
  const ver2 = verion2.split('.');
  let i = 0;
  let v1: number, v2: number;

  /* default is 0, version format should be 1.1.0 */
  while (i < 3) {
    v1 = Number(ver1[i]);
    v2 = Number(ver2[i]);
    if (v1 > v2) return 1;
    if (v1 < v2) return -1;
    i++;
  }
  return 0;
}

async function fileHash(filename: string, algorithm = 'md5') {
  const hash = crypto.createHash(algorithm);
  const input = fs.createReadStream(filename);
  let hashvalue = '';
  return new Promise((resolve, reject) => {
    input.on('readable', () => {
      const data = input.read();
      if (data) {
        hash.update(data);
      }
    });
    input.on('error', reject);
    input.on('end', () => {
      hashvalue = hash.digest('hex');
      return resolve(hashvalue);
    });
  });
}

async function extract(sourceZip: string, targetFoder: string) {
  return new Promise((resolve, reject) => {
    extractzip(sourceZip, {dir: targetFoder}, err => {
      if (err) {
        return reject(err);
      } else {
        return resolve(true);
      }
    });
  });
}
