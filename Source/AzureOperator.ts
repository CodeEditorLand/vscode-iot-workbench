// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import * as vscode from "vscode";

import { RemoteExtension } from "./Models/RemoteExtension";
import { TelemetryContext } from "./telemetry";
import { constructAndLoadIoTProject } from "./utils";

export class AzureOperator {
	async provision(
		context: vscode.ExtensionContext,
		channel: vscode.OutputChannel,
		telemetryContext: TelemetryContext,
	): Promise<void> {
		const iotProject = await constructAndLoadIoTProject(
			context,
			channel,
			telemetryContext,
		);

		if (!iotProject) {
			return;
		}

		const status = await iotProject.provision();

		if (status) {
			vscode.window.showInformationMessage("Azure provision succeeded.");
		}
	}

	async deploy(
		context: vscode.ExtensionContext,
		channel: vscode.OutputChannel,
		telemetryContext: TelemetryContext,
	): Promise<void> {
		// Azure deploy command can be executed only in local environment
		RemoteExtension.ensureLocalBeforeRunCommand(
			"deploy azure project",
			context,
		);

		const iotProject = await constructAndLoadIoTProject(
			context,
			channel,
			telemetryContext,
		);

		if (iotProject) {
			await iotProject.deploy();
		}
	}
}
