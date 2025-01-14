// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as path from "path";
import * as vscode from "vscode";
import * as sdk from "vscode-iot-device-cube-sdk";

import { OperationCanceledError } from "../common/Error/OperationCanceledError";
import { OperationFailedError } from "../common/Error/OperationFailedErrors/OperationFailedError";
import { FileNames, OperationType, ScaffoldType } from "../constants";
import { FileUtility } from "../FileUtility";
import { TelemetryContext } from "../telemetry";
import {
	askAndOpenInRemote,
	channelShowAndAppendLine,
	executeCommand,
} from "../utils";
import { ContainerDeviceBase } from "./ContainerDeviceBase";
import { DeviceType } from "./Interfaces/Device";
import { TemplateFileInfo } from "./Interfaces/ProjectTemplate";
import { RemoteExtension } from "./RemoteExtension";

interface DeviceInfo {
	id: string;

	mac: string;

	ip?: string;

	host?: string;

	ssid?: string;
}

class RaspberryPiUploadConfig {
	static host = "hostname";

	static port = 22;

	static user = "username";

	static password = "password";

	static projectPath = "IoTProject";

	static updated = false;
}

export class RaspberryPiDevice extends ContainerDeviceBase {
	private static _boardId = "raspberrypi";

	name = "Raspberry Pi";

	static get boardId(): string {
		return RaspberryPiDevice._boardId;
	}

	constructor(
		context: vscode.ExtensionContext,
		projectPath: string,
		channel: vscode.OutputChannel,
		telemetryContext: TelemetryContext,
		templateFilesInfo: TemplateFileInfo[] = [],
	) {
		super(
			context,
			projectPath,
			channel,
			telemetryContext,
			DeviceType.RaspberryPi,
			templateFilesInfo,
		);
	}

	private async getBinaryFileName(): Promise<string | undefined> {
		// Parse binary name from CMakeLists.txt file
		const cmakeFilePath = path.join(
			this.projectFolder,
			FileNames.cmakeFileName,
		);

		if (
			!(await FileUtility.fileExists(
				ScaffoldType.Workspace,
				cmakeFilePath,
			))
		) {
			return;
		}

		const getBinaryFileNameCmd = `cat ${cmakeFilePath} | grep 'add_executable' \
    | sed -e 's/^add_executable(//' | awk '{$1=$1};1' | cut -d ' ' -f1 | tr -d '\n'`;

		const binaryName = await executeCommand(getBinaryFileNameCmd);

		return binaryName;
	}

	private async enableBinaryExecutability(
		ssh: sdk.SSH,
		binaryName: string,
	): Promise<void> {
		if (!binaryName) {
			return;
		}

		const chmodCmd = `cd ${RaspberryPiUploadConfig.projectPath} && [ -f ${binaryName} ] && chmod +x ${binaryName}`;

		await ssh.exec(chmodCmd);

		return;
	}

	async upload(): Promise<boolean> {
		const isRemote = RemoteExtension.isRemote(this.extensionContext);

		if (!isRemote) {
			await askAndOpenInRemote(
				OperationType.Upload,
				this.telemetryContext,
			);

			return false;
		}

		try {
			const binaryName = await this.getBinaryFileName();

			if (!binaryName) {
				const message = `No executable file specified in ${FileNames.cmakeFileName}. \
        Nothing to upload to target machine.`;

				vscode.window.showWarningMessage(message);

				channelShowAndAppendLine(this.channel, message);

				return false;
			}

			const binaryFilePath = path.join(this.outputPath, binaryName);

			if (
				!(await FileUtility.fileExists(
					ScaffoldType.Workspace,
					binaryFilePath,
				))
			) {
				const message = `Executable file ${binaryName} does not exist under ${this.outputPath}. \
        Please compile device code first.`;

				vscode.window.showWarningMessage(message);

				channelShowAndAppendLine(this.channel, message);

				return false;
			}

			if (!RaspberryPiUploadConfig.updated) {
				await this.configDeviceSettings();
			}

			const ssh = new sdk.SSH();

			await ssh.open(
				RaspberryPiUploadConfig.host,
				RaspberryPiUploadConfig.port,
				RaspberryPiUploadConfig.user,
				RaspberryPiUploadConfig.password,
			);

			try {
				await ssh.uploadFile(
					binaryFilePath,
					RaspberryPiUploadConfig.projectPath,
				);
			} catch (error) {
				throw new OperationFailedError(
					"upload file to device",
					`SSH traffic is too busy. Error: ${error}`,
					"Please wait a second and retry.",
				);
			}

			try {
				await this.enableBinaryExecutability(ssh, binaryName);
			} catch (error) {
				throw new OperationFailedError(
					"enable binary executability",
					`${error.message}`,
					"",
				);
			}

			try {
				await ssh.close();
			} catch (error) {
				throw new OperationFailedError(
					"close SSH connection",
					`${error.message}`,
					"",
				);
			}

			const message = `Successfully deploy compiled files to device board.`;

			channelShowAndAppendLine(this.channel, message);

			vscode.window.showInformationMessage(message);
		} catch (error) {
			throw new OperationFailedError(
				`upload binary file to device ${RaspberryPiUploadConfig.user}@${RaspberryPiUploadConfig.host} failed.`,
				`${error.message}`,
				"",
			);
		}

		return true;
	}

	private async autoDiscoverDeviceIp(): Promise<vscode.QuickPickItem[]> {
		const sshDevicePickItems: vscode.QuickPickItem[] = [];

		const deviceInfos: DeviceInfo[] = await sdk.SSH.discover();

		deviceInfos.forEach((deviceInfo) => {
			sshDevicePickItems.push({
				label: deviceInfo.ip as string,
				description: deviceInfo.host || "<Unknown>",
			});
		});

		sshDevicePickItems.push(
			{
				label: "$(sync) Discover again",
				detail: "Auto discover SSH enabled device in LAN",
			},
			{
				label: "$(gear) Manual setup",
				detail: "Setup device SSH configuration manually",
			},
		);

		return sshDevicePickItems;
	}

	/**
	 * Configure Raspberry PI device SSH
	 */
	async configDeviceSettings(): Promise<void> {
		// Raspberry Pi host
		const sshDiscoverOrInputItems: vscode.QuickPickItem[] = [
			{
				label: "$(search) Auto discover",
				detail: "Auto discover SSH enabled device in LAN",
			},
			{
				label: "$(gear) Manual setup",
				detail: "Setup device SSH configuration manually",
			},
		];

		const sshDiscoverOrInputChoice = await vscode.window.showQuickPick(
			sshDiscoverOrInputItems,
			{
				ignoreFocusOut: true,
				matchOnDescription: true,
				matchOnDetail: true,
				placeHolder: "Select an option",
			},
		);

		if (!sshDiscoverOrInputChoice) {
			throw new OperationCanceledError(
				"SSH configuration type selection cancelled.",
			);
		}

		let raspiHost: string | undefined;

		if (sshDiscoverOrInputChoice.label === "$(search) Auto discover") {
			let selectDeviceChoice: vscode.QuickPickItem | undefined;

			do {
				const selectDeviceItems = this.autoDiscoverDeviceIp();

				selectDeviceChoice = await vscode.window.showQuickPick(
					selectDeviceItems,
					{
						ignoreFocusOut: true,
						matchOnDescription: true,
						matchOnDetail: true,
						placeHolder: "Select a device",
					},
				);
			} while (
				selectDeviceChoice &&
				selectDeviceChoice.label === "$(sync) Discover again"
			);

			if (!selectDeviceChoice) {
				throw new OperationCanceledError("Device selection cancelled.");
			}

			if (selectDeviceChoice.label !== "$(gear) Manual setup") {
				raspiHost = selectDeviceChoice.label;
			}
		}

		if (!raspiHost) {
			const raspiHostOption: vscode.InputBoxOptions = {
				value: RaspberryPiUploadConfig.host,
				prompt: `Please input device ip or hostname here.`,
				ignoreFocusOut: true,
			};

			raspiHost = await vscode.window.showInputBox(raspiHostOption);

			if (!raspiHost) {
				throw new OperationCanceledError("Hostname input cancelled.");
			}
		}

		raspiHost = raspiHost || RaspberryPiUploadConfig.host;

		// Raspberry Pi SSH port
		const raspiPortOption: vscode.InputBoxOptions = {
			value: RaspberryPiUploadConfig.port.toString(),
			prompt: `Please input SSH port here.`,
			ignoreFocusOut: true,
		};

		const raspiPortString =
			await vscode.window.showInputBox(raspiPortOption);

		if (!raspiPortString) {
			throw new OperationCanceledError("Port input cancelled.");
		}

		const raspiPort =
			raspiPortString && !isNaN(Number(raspiPortString))
				? Number(raspiPortString)
				: RaspberryPiUploadConfig.port;

		// Raspberry Pi user name
		const raspiUserOption: vscode.InputBoxOptions = {
			value: RaspberryPiUploadConfig.user,
			prompt: `Please input user name here.`,
			ignoreFocusOut: true,
		};

		let raspiUser = await vscode.window.showInputBox(raspiUserOption);

		if (!raspiUser) {
			throw new OperationCanceledError("User name input cancelled.");
		}

		raspiUser = raspiUser || RaspberryPiUploadConfig.user;

		// Raspberry Pi user password
		const raspiPasswordOption: vscode.InputBoxOptions = {
			value: RaspberryPiUploadConfig.password,
			prompt: `Please input password here.`,
			ignoreFocusOut: true,
		};

		let raspiPassword =
			await vscode.window.showInputBox(raspiPasswordOption);

		if (raspiPassword === undefined) {
			throw new OperationCanceledError("Password input cancelled.");
		}

		raspiPassword = raspiPassword || RaspberryPiUploadConfig.password;

		// Raspberry Pi path
		const raspiPathOption: vscode.InputBoxOptions = {
			value: RaspberryPiUploadConfig.projectPath,
			prompt: `Please input project destination path here.`,
			ignoreFocusOut: true,
		};

		let raspiPath = await vscode.window.showInputBox(raspiPathOption);

		if (!raspiPath) {
			throw new OperationCanceledError(
				"Project destination path input cancelled.",
			);
		}

		raspiPath = raspiPath || RaspberryPiUploadConfig.projectPath;

		RaspberryPiUploadConfig.host = raspiHost;

		RaspberryPiUploadConfig.port = raspiPort;

		RaspberryPiUploadConfig.user = raspiUser;

		RaspberryPiUploadConfig.password = raspiPassword;

		RaspberryPiUploadConfig.projectPath = raspiPath;

		RaspberryPiUploadConfig.updated = true;

		vscode.window.showInformationMessage("Config SSH successfully.");
	}
}
