// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as path from "path";
import * as fs from "fs-plus";
import * as vscode from "vscode";

import { OperationCanceledError } from "../common/Error/OperationCanceledError";
import { ArgumentEmptyOrNullError } from "../common/Error/OperationFailedErrors/ArgumentEmptyOrNullError";
import { DependentExtensionNotFoundError } from "../common/Error/OperationFailedErrors/DependentExtensionNotFoundError";
import { DirectoryNotFoundError } from "../common/Error/OperationFailedErrors/DirectoryNotFoundError";
import { FileNotFoundError } from "../common/Error/OperationFailedErrors/FileNotFound";
import { WorkspaceNotOpenError } from "../common/Error/OperationFailedErrors/WorkspaceNotOpenError";
import { WorkspaceConfigNotFoundError } from "../common/Error/SystemErrors/WorkspaceConfigNotFoundError";
import { ConfigHandler } from "../configHandler";
import {
	ConfigKey,
	FileNames,
	OperationType,
	OSPlatform,
	PlatformType,
	ScaffoldType,
} from "../constants";
import { FileUtility } from "../FileUtility";
import { TelemetryContext } from "../telemetry";
import * as utils from "../utils";
import { checkExtensionAvailable } from "./Apis";
import { ExtensionName } from "./Interfaces/Api";
import { Board } from "./Interfaces/Board";
import { ComponentType } from "./Interfaces/Component";
import { Device, DeviceType } from "./Interfaces/Device";
import { TemplateFileInfo } from "./Interfaces/ProjectTemplate";
import { OTA } from "./OTA";

const constants = {
	defaultSketchFileName: "device.ino",
	arduinoJsonFileName: "arduino.json",
	cppPropertiesFileName: "c_cpp_properties.json",
	cppPropertiesFileNameMac: "c_cpp_properties_macos.json",
	cppPropertiesFileNameLinux: "c_cpp_properties_linux.json",
	cppPropertiesFileNameWin: "c_cpp_properties_win32.json",
	outputPath: "./.build",
	compileTaskName: "Arduino Compile",
	uploadTaskName: "Arduino Upload",
	environmentTemplateFolderName: "Arduino Task",
};

export abstract class ArduinoDeviceBase implements Device {
	protected deviceType: DeviceType;

	protected componentType: ComponentType;

	protected deviceFolder: string;

	protected vscodeFolderPath: string;

	protected boardFolderPath: string;

	protected channel: vscode.OutputChannel;

	protected extensionContext: vscode.ExtensionContext;

	protected telemetryContext: TelemetryContext;

	protected templateFiles: TemplateFileInfo[] = [];

	abstract name: string;

	abstract id: string;

	abstract board: Board;

	constructor(
		context: vscode.ExtensionContext,
		devicePath: string,
		channel: vscode.OutputChannel,
		telemetryContext: TelemetryContext,
		deviceType: DeviceType,
	) {
		this.deviceType = deviceType;

		this.componentType = ComponentType.Device;

		this.deviceFolder = devicePath;

		this.extensionContext = context;

		this.vscodeFolderPath = path.join(
			this.deviceFolder,
			FileNames.vscodeSettingsFolderName,
		);

		this.boardFolderPath = context.asAbsolutePath(
			path.join(
				FileNames.resourcesFolderName,
				FileNames.templatesFolderName,
			),
		);

		this.telemetryContext = telemetryContext;

		this.channel = channel;
	}

	getDeviceType(): DeviceType {
		return this.deviceType;
	}

	getComponentType(): ComponentType {
		return this.componentType;
	}

	static async isAvailable(): Promise<boolean> {
		return await checkExtensionAvailable(ExtensionName.Arduino);
	}

	async checkPrerequisites(operation: string): Promise<void> {
		const res = await ArduinoDeviceBase.isAvailable();

		if (!res) {
			throw new DependentExtensionNotFoundError(
				operation,
				ExtensionName.Arduino,
			);
		}
	}

	async compile(): Promise<boolean> {
		const result = await this.preCompileAction();

		if (!result) {
			return false;
		}

		await utils.fetchAndExecuteTask(
			this.extensionContext,
			this.channel,
			this.telemetryContext,
			this.deviceFolder,
			OperationType.Compile,
			PlatformType.Arduino,
			constants.compileTaskName,
		);

		return true;
	}

	async upload(): Promise<boolean> {
		const result = await this.preUploadAction();

		if (!result) {
			return false;
		}

		await utils.fetchAndExecuteTask(
			this.extensionContext,
			this.channel,
			this.telemetryContext,
			this.deviceFolder,
			OperationType.Upload,
			PlatformType.Arduino,
			constants.uploadTaskName,
		);

		return true;
	}

	abstract async configDeviceSettings(): Promise<void>;

	async load(): Promise<void> {
		const loadTimeScaffoldType = ScaffoldType.Workspace;

		if (
			!(await FileUtility.directoryExists(
				loadTimeScaffoldType,
				this.deviceFolder,
			))
		) {
			throw new DirectoryNotFoundError(
				"load Arduino device",
				`device folder ${this.deviceFolder}`,
				"Please initialize the device first.",
			);
		}

		await this.generateCppPropertiesFile(loadTimeScaffoldType, this.board);
	}

	abstract async create(): Promise<void>;

	async createCore(): Promise<void> {
		// Generate template files
		const createTimeScaffoldType = ScaffoldType.Local;

		if (
			!(await FileUtility.directoryExists(
				createTimeScaffoldType,
				this.deviceFolder,
			))
		) {
			throw new DirectoryNotFoundError(
				"create Arduino device",
				`device folder ${this.deviceFolder}`,
				"Please initialize the device first.",
			);
		}

		for (const fileInfo of this.templateFiles) {
			await utils.generateTemplateFile(
				this.deviceFolder,
				createTimeScaffoldType,
				fileInfo,
			);
		}

		await this.generateCppPropertiesFile(
			createTimeScaffoldType,
			this.board,
		);

		// Configurate device environment
		await this.configDeviceEnvironment(
			this.deviceFolder,
			createTimeScaffoldType,
		);
	}

	// Backward compatibility: Check configuration
	abstract async preCompileAction(): Promise<boolean>;

	abstract async preUploadAction(): Promise<boolean>;

	abstract get version(): string;

	private async writeCppPropertiesFile(
		boardId: string,
		type: ScaffoldType,
		platform: string,
	): Promise<void> {
		const cppPropertiesFilePath = path.join(
			this.vscodeFolderPath,
			constants.cppPropertiesFileName,
		);

		if (await FileUtility.fileExists(type, cppPropertiesFilePath)) {
			return;
		}

		let cppPropertiesTemplateFileName: string;

		let changeRootPath = false;

		let rootPath: string = await utils.getHomeDir();

		if (platform === OSPlatform.WIN32) {
			rootPath = path
				.join(rootPath, "AppData", "Local")
				.replace(/\\/g, "\\\\");

			cppPropertiesTemplateFileName = constants.cppPropertiesFileNameWin;

			changeRootPath = true;
		} else if (platform === OSPlatform.LINUX) {
			cppPropertiesTemplateFileName =
				constants.cppPropertiesFileNameLinux;

			changeRootPath = true;
		} else {
			// TODO: Let's use the MacOS template file for OS that is not win32/linux.
			// Revisit this part if want to support other OS.
			cppPropertiesTemplateFileName = constants.cppPropertiesFileNameMac;
		}

		const cppPropertiesTemplateFilePath =
			this.extensionContext.asAbsolutePath(
				path.join(
					FileNames.resourcesFolderName,
					FileNames.templatesFolderName,
					boardId,
					cppPropertiesTemplateFileName,
				),
			);

		const propertiesContent = await FileUtility.readFile(
			type,
			cppPropertiesTemplateFilePath,
		);

		const propertiesContentString = propertiesContent.toString();

		const versionPattern = /{VERSION}/g;

		let content = propertiesContentString.replace(
			versionPattern,
			this.version,
		);

		if (changeRootPath) {
			const rootPathPattern = /{ROOTPATH}/g;

			content = content.replace(rootPathPattern, rootPath);
		}

		await FileUtility.writeFile(type, cppPropertiesFilePath, content);
	}

	async generateCppPropertiesFile(
		type: ScaffoldType,
		board: Board,
	): Promise<void> {
		if (!(await FileUtility.directoryExists(type, this.vscodeFolderPath))) {
			await FileUtility.mkdirRecursively(type, this.vscodeFolderPath);
		}

		// Create c_cpp_properties.json file
		const platform = await utils.getPlatform();

		await this.writeCppPropertiesFile(board.id, type, platform);
	}

	async generateCrc(channel: vscode.OutputChannel): Promise<void> {
		const devicePath = ConfigHandler.get<string>(ConfigKey.devicePath);

		if (!devicePath) {
			throw new WorkspaceConfigNotFoundError(ConfigKey.devicePath);
		}

		const rootPath = utils.getProjectDeviceRootPath();

		if (!rootPath) {
			throw new WorkspaceNotOpenError("generate CRC");
		}

		const deviceBuildLocation = path.join(
			rootPath,
			"..",
			devicePath,
			".build",
		);

		if (!fs.isDirectorySync(deviceBuildLocation)) {
			throw new DirectoryNotFoundError(
				"generate CRC",
				"device build output folder",
				"Please compile the project first.",
			);
		}

		const binFiles = fs.listSync(deviceBuildLocation, ["bin"]);

		if (!binFiles || !binFiles.length) {
			throw new FileNotFoundError(
				"generate CRC",
				"bin file",
				"Please compile the project first.",
			);
		}

		let binFilePath = "";

		if (binFiles.length === 1) {
			binFilePath = binFiles[0];
		} else {
			const binFilePickItems: vscode.QuickPickItem[] = [];

			for (const file of binFiles) {
				const fileName = path.basename(file);

				binFilePickItems.push({ label: fileName, description: file });
			}

			const choice = await vscode.window.showQuickPick(binFilePickItems, {
				ignoreFocusOut: true,
				matchOnDescription: true,
				matchOnDetail: true,
				placeHolder: "Select bin file",
			});

			if (!choice || !choice.description) {
				throw new OperationCanceledError(
					"Bin file selection cancelled.",
				);
			}

			binFilePath = choice.description;
		}

		if (!binFilePath || !fs.existsSync(binFilePath)) {
			throw new FileNotFoundError(
				"generate CRC",
				`bin file ${binFilePath}`,
				"Please compile the project first.",
			);
		}

		const res = OTA.generateCrc(binFilePath);

		vscode.window.showInformationMessage("Generate CRC succeeded.");

		channel.show();

		channel.appendLine("========== CRC Information ==========");

		channel.appendLine("");

		channel.appendLine("fwPath: " + binFilePath);

		channel.appendLine("fwPackageCheckValue: " + res.crc);

		channel.appendLine("fwSize: " + res.size);

		channel.appendLine("");

		channel.appendLine("======================================");
	}

	async configDeviceEnvironment(
		deviceRootPath: string,
		scaffoldType: ScaffoldType,
	): Promise<void> {
		if (!deviceRootPath) {
			throw new ArgumentEmptyOrNullError(
				"configurate device environment",
				"device root path",
				"Please open the folder and initialize project again.",
			);
		}

		const templateFilesInfo =
			await utils.getEnvTemplateFilesAndAskOverwrite(
				this.extensionContext,
				this.deviceFolder,
				scaffoldType,
				constants.environmentTemplateFolderName,
			);

		// Configure project environment with template files
		for (const fileInfo of templateFilesInfo) {
			await utils.generateTemplateFile(
				deviceRootPath,
				scaffoldType,
				fileInfo,
			);
		}

		const message = "Arduino device configuration done.";

		utils.channelShowAndAppendLine(this.channel, message);
	}
}
