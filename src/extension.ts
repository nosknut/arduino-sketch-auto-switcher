import * as TOML from '@iarna/toml';
import { basename, dirname, sep as pathSeparator, relative } from 'path';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

type WokWiToml = {
	wokwi: {
		version: number;
		firmware: string;
		elf: string;
	};
};

function getForwardSlashPath(path: string) {
	return path
		.split(pathSeparator)
		.join('/');
}

function getConfig() {
	return vscode.workspace.getConfiguration("arduino-sketch-auto-switcher");
}

async function deleteWorkspaceFile(uri: vscode.Uri) {
	await vscode.workspace.fs.delete(uri);
}

function getHumanReadableWorkspacePath(uri: vscode.Uri) {
	return vscode.workspace.asRelativePath(uri);
	// getForwardSlashPath(join('.', vscode.workspace.asRelativePath(uri)));
}

async function deleteFirmware(buildTargetUri: vscode.Uri) {
	const firmware = await findWorkspaceFile(
		new vscode.RelativePattern(buildTargetUri, "*.hex")
	);
	const elf = await findWorkspaceFile(
		new vscode.RelativePattern(buildTargetUri, "*.elf")
	);

	if (firmware) {
		await deleteWorkspaceFile(firmware);
	}

	if (elf) {
		await deleteWorkspaceFile(elf);
	}
}

async function writeWorkspaceFile(uri: vscode.Uri, content: string) {
	await vscode.workspace.fs.writeFile(uri, Buffer.from(content));
}

async function writeJsonWorkspaceFile(uri: vscode.Uri, content: object) {
	await writeWorkspaceFile(uri, JSON.stringify(content, null, 4));
}

function getWorkspaceFileName(uri: vscode.Uri) {
	return basename(uri.toString());
}

function getRelativePath(from: vscode.Uri, to: vscode.Uri) {

	const rel1 = vscode.workspace.asRelativePath(from);
	const rel2 = vscode.workspace.asRelativePath(to);

	const rel3 = getForwardSlashPath(relative(
		rel1,
		rel2,
	));
	return rel3;
}

async function getFirmwarePaths(buildTargetUri: vscode.Uri, sketchUri: vscode.Uri) {
	const sketchName = getWorkspaceFileName(sketchUri);
	const sketchDirUri = getWorkspaceFileDirectory(sketchUri);

	return {
		hexPath: getRelativePath(
			sketchDirUri,
			vscode.Uri.joinPath(buildTargetUri, `${sketchName}.hex`),
		),
		elfPath: getRelativePath(
			sketchDirUri,
			vscode.Uri.joinPath(buildTargetUri, `${sketchName}.elf`),
		),
	};
}

async function updateToml(tomlFileUri: vscode.Uri, hexFilePath: string, elfFilePath: string) {
	const tomlFile = await vscode.workspace.openTextDocument(tomlFileUri);
	try {
		const toml = TOML.parse(tomlFile.getText()) as WokWiToml;
		if (toml.wokwi) {
			const original = TOML.stringify(toml);
			toml.wokwi.firmware = hexFilePath;
			toml.wokwi.elf = elfFilePath;
			const updated = TOML.stringify(toml);

			if (updated !== original) {
				await writeWorkspaceFile(tomlFileUri, TOML.stringify(toml));
			}
		}
	} catch (e) {
		console.error(e);
	}
}

async function findWorkspaceFile(pattern: vscode.GlobPattern) {
	const files = await vscode.workspace.findFiles(pattern);

	if (files.length === 0) {
		return;
	}

	return files[0];
}

async function getArduinoConfigUri(workspaceUri: vscode.Uri) {
	return await findWorkspaceFile(
		new vscode.RelativePattern(workspaceUri, "**/arduino.json")
	);
}

async function showArduinoSetup() {
	if (getConfig().get("autoShowConfigurationOnMissingArduinoJson")) {

		const openBoardManager = await vscode.window.showWarningMessage(
			"Missing Arduino config. Would you like to open the Board Manager?",
			"Yes",
			"No",
		);

		if (openBoardManager === "Yes") {
			await vscode.commands.executeCommand('arduino.showBoardManager');
		}

		const selectBoard = await vscode.window.showWarningMessage(
			"Missing Arduino config. Would you like to select a board?",
			"Yes",
			"No",
		);

		if (selectBoard === "Yes") {
			await vscode.commands.executeCommand('arduino.changeBoardType');
		}

		const selectProgrammer = await vscode.window.showWarningMessage(
			"Missing Arduino config. Would you like to select a programmer?",
			"Yes",
			"No",
		);

		if (selectProgrammer === "Yes") {
			await vscode.commands.executeCommand('arduino.selectProgrammer');
		}
	}
}

type ArduinoConfig = {
	output: string,
	sketch: string,
};

async function getWorkspaceJsonFile<T>(uri: vscode.Uri) {
	const doc = await vscode.workspace.openTextDocument(uri);
	return JSON.parse(doc.getText()) as T;
}

/**
 * Updates the default Arduino output path in arduino.json if it is not set
 * @returns true if the output path was updated
 */
async function setDefaultArduinoOutput(arduinoConfig: ArduinoConfig) {
	if (!arduinoConfig.output) {
		arduinoConfig.output = getConfig().get("defaultArduinoOutput") || "";
		vscode.window.showInformationMessage('Arduino Sketch Auto Switcher: Updated build output path in arduino.json');
		return true;
	}

	return false;
}

function getArduinoBuildTargetUri(workspaceUri: vscode.Uri, arduinoConfig: ArduinoConfig) {
	return vscode.Uri.joinPath(
		workspaceUri,
		arduinoConfig.output,
	);
}

async function sketchIsSelected(uri: vscode.Uri, arduinoConfig: ArduinoConfig) {
	return arduinoConfig.sketch === vscode.workspace.asRelativePath(uri);
}

async function verifySketch() {
	await vscode.commands.executeCommand('arduino.verify');
}

// Temporarily disables a setting while running some code
async function runWithoutSetting(configuration: string, setting: string, callback: () => Promise<void>) {
	const config = vscode.workspace.getConfiguration(configuration);
	const originalValue = config.get(setting);
	if (originalValue) {
		await config.update(setting, false);
		await callback();
		await config.update(setting, originalValue);
	} else {
		await callback();
	}
}

async function selectArduinoSketch(
	uri: vscode.Uri,
	verify: boolean,
	verifyWithoutChanges: boolean,
	arduinoConfigUri: vscode.Uri,
	arduinoConfig: ArduinoConfig,
) {
	const status = {
		verified: false,
		updatedSketch: false,
		updatedOutput: false,
	};

	if (!fileIsSketch(uri)) {
		vscode.window.showErrorMessage('Arduino Sketch Auto Switcher: Selected file is not an Arduino sketch');
		return status;
	}

	const sketchAlreadySelected = await sketchIsSelected(uri, arduinoConfig);

	if (!sketchAlreadySelected) {
		status.updatedSketch = true;
		arduinoConfig.sketch = getHumanReadableWorkspacePath(uri);
		// vscode.window.showInformationMessage(`Arduino Sketch Auto Switcher: Selected ${getWorkspaceFileName(uri)}`);
	}

	if (await setDefaultArduinoOutput(arduinoConfig)) {
		status.updatedOutput = true;
	}

	const somethingChanged = status.updatedOutput || status.updatedSketch;

	if (somethingChanged) {
		// TODO: For some reason this is not working.
		// The Arduino extension still analyzes the
		// sketch despite the setting being set to false
		// Force the Arduino Extension to not analyze the sketch on change
		await runWithoutSetting('arduino', 'analyzeOnSettingChange', async () => {
			await writeJsonWorkspaceFile(arduinoConfigUri, arduinoConfig);
		});
	}

	if (verify) {
		if (somethingChanged || verifyWithoutChanges) {
			await verifySketch();
			status.verified = true;
		}
	}

	return status;
}

function getWorkspaceFileDirectory(uri: vscode.Uri) {
	return vscode.Uri.parse(dirname(uri.toString()));
}

async function getSketchSimFileUris(sketchUri: vscode.Uri) {
	const sketchDir = getWorkspaceFileDirectory(sketchUri);
	const tomlUri = vscode.Uri.joinPath(sketchDir, "wokwi.toml");
	const diagramUri = vscode.Uri.joinPath(sketchDir, "diagram.json");
	return {
		tomlUri,
		diagramUri,
	};
}

async function workspaceFileExists(uri: vscode.Uri) {
	return !!await findWorkspaceFile(vscode.workspace.asRelativePath(uri));
}

async function sketchHasSimulation(sketchUri: vscode.Uri) {
	const { tomlUri, diagramUri } = await getSketchSimFileUris(sketchUri);
	const tomlExists = await workspaceFileExists(tomlUri);
	const diagramExists = await workspaceFileExists(diagramUri);
	return tomlExists || diagramExists;
}

async function configureWokwiTomlFirmwarePaths(buildTargetUri: vscode.Uri, sketchUri: vscode.Uri) {
	const exists = await sketchHasSimulation(sketchUri);
	if (!exists) {
		return;
	}

	const { tomlUri } = await getSketchSimFileUris(sketchUri);

	const firmwarePaths = await getFirmwarePaths(buildTargetUri, sketchUri);

	if (!firmwarePaths) {
		return;
	}

	const { hexPath, elfPath } = firmwarePaths;
	await updateToml(
		tomlUri,
		hexPath,
		elfPath,
	);

	// Using a 3 second timeout to give the Arduino extension
	// enough time to start building the sketch
	// Without this the build will cause the UI to loose focus
	setTimeout(async () => {
		const selectSimulationCOnfig = await vscode.window.showWarningMessage(
			"Would you like to select the simulation for the current sketch?",
			"Yes",
			"No",
		);

		if (selectSimulationCOnfig === "Yes") {
			await vscode.commands.executeCommand('wokwi-vscode.selectConfigFile');
		}
	}, 3000);
}

function fileIsSketch(uri: vscode.Uri) {
	return uri.path.endsWith('.ino');
}

const templates = {
	uno: {
		"version": 1,
		"author": "wokwi",
		"editor": "wokwi",
		"parts": [{ "type": "wokwi-arduino-uno", "id": "uno", "top": 0, "left": 0, "attrs": {} }],
		"connections": [],
		"dependencies": {}
	},
	uno1Button: {
		"version": 1,
		"author": "wokwi",
		"editor": "wokwi",
		"parts": [
			{ "type": "wokwi-breadboard-half", "id": "bb1", "top": 45, "left": -74, "attrs": {} },
			{
				"type": "wokwi-arduino-uno",
				"id": "uno",
				"top": -212.52,
				"left": -92.82,
				"rotate": 180,
				"attrs": {}
			},
			{
				"type": "wokwi-pushbutton",
				"id": "btn1",
				"top": 143.9,
				"left": -63.7,
				"rotate": 90,
				"attrs": { "color": "black", "bounce": "1" }
			},
			{
				"type": "wokwi-resistor",
				"id": "r1",
				"top": 91.2,
				"left": -67.75,
				"rotate": 90,
				"attrs": { "value": "1000" }
			}
		],
		"connections": [
			["uno:5V", "bb1:tp.24", "red", ["v-21.57", "h185.23"]],
			["uno:GND.2", "bb1:tn.25", "black", ["v-33.17", "h191.11"]],
			["r1:2", "uno:2", "orange", ["h0"]],
			["bb1:4t.a", "bb1:tp.3", "red", ["v0"]],
			["bb1:29t.a", "bb1:tp.24", "red", ["v0"]],
			["btn1:1.l", "bb1:4t.e", "", ["$bb"]],
			["btn1:2.l", "bb1:2t.e", "", ["$bb"]],
			["btn1:1.r", "bb1:4b.j", "", ["$bb"]],
			["btn1:2.r", "bb1:2b.j", "", ["$bb"]],
			["r1:1", "bb1:tn.1", "", ["$bb"]],
			["r1:2", "bb1:2t.d", "", ["$bb"]]
		],
		"dependencies": {}
	},
	uno1Led: {
		"version": 1,
		"author": "wokwi",
		"editor": "wokwi",
		"parts": [
			{ "type": "wokwi-breadboard-half", "id": "bb1", "top": 45, "left": -74, "attrs": {} },
			{
				"type": "wokwi-arduino-uno",
				"id": "uno",
				"top": -212.52,
				"left": -92.82,
				"rotate": 180,
				"attrs": {}
			},
			{
				"type": "wokwi-led",
				"id": "led1",
				"top": 126.4,
				"left": -5.4,
				"rotate": 180,
				"attrs": { "color": "red" }
			},
			{
				"type": "wokwi-resistor",
				"id": "r2",
				"top": 91.2,
				"left": -10.15,
				"rotate": 90,
				"attrs": { "value": "1000" }
			}
		],
		"connections": [
			["uno:5V", "bb1:tp.24", "red", ["v-21.57", "h185.23"]],
			["uno:GND.2", "bb1:tn.25", "black", ["v-33.17", "h191.11"]],
			["bb1:29t.a", "bb1:tp.24", "red", ["v0"]],
			["bb1:7t.a", "uno:5", "green", ["v-59.27", "h-25.93"]],
			["led1:A", "bb1:7t.e", "", ["$bb"]],
			["led1:C", "bb1:8t.e", "", ["$bb"]],
			["r2:1", "bb1:tn.6", "", ["$bb"]],
			["r2:2", "bb1:8t.d", "", ["$bb"]]
		],
		"dependencies": {}
	},
	uno1Button1Led: {
		"version": 1,
		"author": "wokwi",
		"editor": "wokwi",
		"parts": [
			{ "type": "wokwi-breadboard-half", "id": "bb1", "top": 45, "left": -74, "attrs": {} },
			{
				"type": "wokwi-arduino-uno",
				"id": "uno",
				"top": -212.52,
				"left": -92.82,
				"rotate": 180,
				"attrs": {}
			},
			{
				"type": "wokwi-pushbutton",
				"id": "btn1",
				"top": 143.9,
				"left": -63.7,
				"rotate": 90,
				"attrs": { "color": "black", "bounce": "1" }
			},
			{
				"type": "wokwi-resistor",
				"id": "r1",
				"top": 91.2,
				"left": -67.75,
				"rotate": 90,
				"attrs": { "value": "1000" }
			},
			{
				"type": "wokwi-led",
				"id": "led1",
				"top": 126.4,
				"left": -5.4,
				"rotate": 180,
				"attrs": { "color": "red" }
			},
			{
				"type": "wokwi-resistor",
				"id": "r2",
				"top": 91.2,
				"left": -10.15,
				"rotate": 90,
				"attrs": { "value": "1000" }
			}
		],
		"connections": [
			["uno:5V", "bb1:tp.24", "red", ["v-21.57", "h185.23"]],
			["uno:GND.2", "bb1:tn.25", "black", ["v-33.17", "h191.11"]],
			["r1:2", "uno:2", "orange", ["h0"]],
			["bb1:4t.a", "bb1:tp.3", "red", ["v0"]],
			["bb1:29t.a", "bb1:tp.24", "red", ["v0"]],
			["led1:A", "bb1:7t.e", "", ["$bb"]],
			["led1:C", "bb1:8t.e", "", ["$bb"]],
			["r2:1", "bb1:tn.6", "", ["$bb"]],
			["r2:2", "bb1:8t.d", "", ["$bb"]],
			["btn1:1.l", "bb1:4t.e", "", ["$bb"]],
			["btn1:2.l", "bb1:2t.e", "", ["$bb"]],
			["btn1:1.r", "bb1:4b.j", "", ["$bb"]],
			["btn1:2.r", "bb1:2b.j", "", ["$bb"]],
			["r1:1", "bb1:tn.1", "", ["$bb"]],
			["r1:2", "bb1:2t.d", "", ["$bb"]],
			["bb1:7t.a", "uno:5", "green", ["v-59.27", "h-25.93"]]
		],
		"dependencies": {}
	},
	uno2Buttons2Leds: {
		"version": 1,
		"author": "wokwi",
		"editor": "wokwi",
		"parts": [
			{ "type": "wokwi-breadboard-half", "id": "bb1", "top": 45, "left": -74, "attrs": {} },
			{
				"type": "wokwi-arduino-uno",
				"id": "uno",
				"top": -212.52,
				"left": -92.82,
				"rotate": 180,
				"attrs": {}
			},
			{
				"type": "wokwi-pushbutton",
				"id": "btn1",
				"top": 143.9,
				"left": -63.7,
				"rotate": 90,
				"attrs": { "color": "black", "bounce": "1" }
			},
			{
				"type": "wokwi-resistor",
				"id": "r1",
				"top": 91.2,
				"left": -67.75,
				"rotate": 90,
				"attrs": { "value": "1000" }
			},
			{
				"type": "wokwi-led",
				"id": "led1",
				"top": 126.4,
				"left": -5.4,
				"rotate": 180,
				"attrs": { "color": "red" }
			},
			{
				"type": "wokwi-resistor",
				"id": "r2",
				"top": 91.2,
				"left": -10.15,
				"rotate": 90,
				"attrs": { "value": "1000" }
			},
			{
				"type": "wokwi-pushbutton",
				"id": "btn2",
				"top": 143.9,
				"left": 176.3,
				"rotate": 90,
				"attrs": { "color": "black", "bounce": "1" }
			},
			{
				"type": "wokwi-resistor",
				"id": "r3",
				"top": 91.2,
				"left": 172.25,
				"rotate": 90,
				"attrs": { "value": "1000" }
			},
			{
				"type": "wokwi-led",
				"id": "led2",
				"top": 126.4,
				"left": 148.2,
				"rotate": 180,
				"attrs": { "color": "red" }
			},
			{
				"type": "wokwi-resistor",
				"id": "r4",
				"top": 91.2,
				"left": 143.45,
				"rotate": 90,
				"attrs": { "value": "1000" }
			}
		],
		"connections": [
			["uno:5V", "bb1:tp.24", "red", ["v-21.57", "h185.23"]],
			["uno:GND.2", "bb1:tn.25", "black", ["v-33.17", "h191.11"]],
			["r1:2", "uno:2", "orange", ["h0"]],
			["bb1:4t.a", "bb1:tp.3", "red", ["v0"]],
			["r3:2", "uno:13", "orange", ["h-13.93", "v-122.6", "h-131.49"]],
			["bb1:29t.a", "bb1:tp.24", "red", ["v0"]],
			["uno:10", "bb1:23t.a", "green", ["v25.59", "h137.32"]],
			["led1:A", "bb1:7t.e", "", ["$bb"]],
			["led1:C", "bb1:8t.e", "", ["$bb"]],
			["r2:1", "bb1:tn.6", "", ["$bb"]],
			["r2:2", "bb1:8t.d", "", ["$bb"]],
			["btn1:1.l", "bb1:4t.e", "", ["$bb"]],
			["btn1:2.l", "bb1:2t.e", "", ["$bb"]],
			["btn1:1.r", "bb1:4b.j", "", ["$bb"]],
			["btn1:2.r", "bb1:2b.j", "", ["$bb"]],
			["r1:1", "bb1:tn.1", "", ["$bb"]],
			["r1:2", "bb1:2t.d", "", ["$bb"]],
			["btn2:1.l", "bb1:29t.e", "", ["$bb"]],
			["btn2:2.l", "bb1:27t.e", "", ["$bb"]],
			["btn2:1.r", "bb1:29b.j", "", ["$bb"]],
			["btn2:2.r", "bb1:27b.j", "", ["$bb"]],
			["r3:1", "bb1:tn.22", "", ["$bb"]],
			["r3:2", "bb1:27t.d", "", ["$bb"]],
			["led2:A", "bb1:23t.e", "", ["$bb"]],
			["led2:C", "bb1:24t.e", "", ["$bb"]],
			["r4:1", "bb1:tn.20", "", ["$bb"]],
			["r4:2", "bb1:24t.d", "", ["$bb"]],
			["bb1:7t.a", "uno:5", "green", ["v-59.27", "h-25.93"]]
		],
		"dependencies": {}
	},
};

async function requestDiagramTemplateFromUser() {
	const sketchTypes = {
		uno: "UNO",
		uno1Button: "UNO with 1 button",
		uno1Led: "UNO with 1 LED",
		uno1Button1Led: "UNO with 1 button and 1 LED",
		uno2Buttons2Leds: "UNO with 2 buttons and 2 LEDs",
	};

	const sketchType = await vscode.window.showQuickPick([
		{ label: sketchTypes.uno, description: sketchTypes.uno, },
		{ label: sketchTypes.uno1Button, description: sketchTypes.uno1Button, },
		{ label: sketchTypes.uno1Led, description: sketchTypes.uno1Led, },
		{ label: sketchTypes.uno1Button1Led, description: sketchTypes.uno1Button1Led, },
		{ label: sketchTypes.uno2Buttons2Leds, description: sketchTypes.uno2Buttons2Leds, },
	], {
		placeHolder: "Select a sketch type",
		matchOnDescription: true,
	});

	if (!sketchType) {
		return;
	}

	const diagrams = {
		[sketchTypes.uno]: templates.uno,
		[sketchTypes.uno1Button]: templates.uno1Button,
		[sketchTypes.uno1Led]: templates.uno1Led,
		[sketchTypes.uno1Button1Led]: templates.uno1Button1Led,
		[sketchTypes.uno2Buttons2Leds]: templates.uno2Buttons2Leds,
	};

	const diagram = diagrams[sketchType.label];

	if (!diagram) {
		vscode.window.showErrorMessage('Arduino Sketch Auto Switcher: Unable to find diagram template');
		return;
	}

	return diagram;
}

function getWorkspaceUri(sketchUri: vscode.Uri) {
	const workspaceFolder = vscode.workspace.getWorkspaceFolder(sketchUri);
	if (!workspaceFolder) {
		return;
	}
	return workspaceFolder.uri;
}

async function standardSetup(sketchUri: vscode.Uri) {

	if (!fileIsSketch(sketchUri)) {
		return;
	}

	const workspaceUri = getWorkspaceUri(sketchUri);

	if (!workspaceUri) {
		return;
	}

	const arduinoConfigUri = await getArduinoConfigUri(workspaceUri);

	if (!arduinoConfigUri) {
		showArduinoSetup();
		return;
	}

	const arduinoConfig = await getWorkspaceJsonFile<ArduinoConfig>(arduinoConfigUri);

	const buildTargetUri = getArduinoBuildTargetUri(workspaceUri, arduinoConfig);

	return {
		arduinoConfigUri,
		arduinoConfig,
		buildTargetUri,
	};
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated

	context.subscriptions.push(
		vscode.commands.registerCommand('arduino-sketch-auto-switcher.selectWokwiConfigFile', async (args: any) => {
			await vscode.commands.executeCommand('wokwi-vscode.selectConfigFile');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('arduino-sketch-auto-switcher.startWokwiSimulation', async (args: any) => {
			await vscode.commands.executeCommand('wokwi-vscode.start');
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument(async (e) => {
			const sketchUri = e?.uri;

			if (!sketchUri) {
				return;
			}

			const setupResult = await standardSetup(sketchUri);

			if (!setupResult) {
				return;
			}

			const {
				arduinoConfigUri,
				arduinoConfig,
				buildTargetUri,
			} = setupResult;

			if (getConfig().get("autoSelectSketchOnSave")) {
				const {
					updatedSketch,
				} = await selectArduinoSketch(
					sketchUri,
					!!getConfig().get("autoVerifySketchOnSave"),
					true,
					arduinoConfigUri,
					arduinoConfig,
				);

				if (updatedSketch && getConfig().get("autoConfigureWokwiTomlFirmwarePathOnSketchSave")) {
					await configureWokwiTomlFirmwarePaths(buildTargetUri, sketchUri);
				}

				if (getConfig().get("autoRestartSimulationOnSave")) {
					if (await sketchHasSimulation(sketchUri)) {
						await vscode.commands.executeCommand('wokwi-vscode.start');
					}
				}

			}
		})
	);

	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(async (e) => {
			const sketchUri = e?.document?.uri;

			if (!sketchUri) {
				return;
			}

			const setupResult = await standardSetup(sketchUri);

			if (!setupResult) {
				return;
			}

			const {
				arduinoConfigUri,
				arduinoConfig,
				buildTargetUri,
			} = setupResult;

			if (getConfig().get("autoSelectSketchOnOpen")) {
				const {
					updatedSketch,
				} = await selectArduinoSketch(
					sketchUri,
					!!getConfig().get("autoCompileSketchOnOpen"),
					false,
					arduinoConfigUri,
					arduinoConfig,
				);

				if (updatedSketch && getConfig().get("autoConfigureWokwiTomlFirmwarePathOnSketchOpen")) {
					await configureWokwiTomlFirmwarePaths(buildTargetUri, sketchUri);
				}
			}

		}));

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	let disposable = vscode.commands.registerCommand('arduino-sketch-auto-switcher.newWokwiSimulation', async (uriArg: vscode.Uri) => {
		// The code you place here will be executed every time your command is executed

		const activeSketch = vscode.window.activeTextEditor?.document.uri;
		const usingActiveSketch = !uriArg;
		const sketchUri = uriArg || activeSketch;

		if (usingActiveSketch && !activeSketch) {
			vscode.window.showErrorMessage('Arduino Sketch Auto Switcher: No sketch is open');
			return;
		}

		if (usingActiveSketch && !fileIsSketch(sketchUri)) {
			vscode.window.showErrorMessage('Arduino Sketch Auto Switcher: You must open a .ino file to create a simulation');
			return;
		}

		const alreadyHasSimulation = await sketchHasSimulation(sketchUri);
		if (alreadyHasSimulation) {
			const shouldOverwrite = await vscode.window.showWarningMessage(
				'This sketch already has a simulation. Would you like to overwrite it?',
				'Yes',
				'No',
			);

			if (shouldOverwrite === 'No') {
				return;
			}
		}

		const setupResult = await standardSetup(sketchUri);

		if (!setupResult) {
			return;
		}

		const {
			arduinoConfigUri,
			arduinoConfig,
			buildTargetUri,
		} = setupResult;

		const { hexPath, elfPath } = await getFirmwarePaths(buildTargetUri, sketchUri);

		const tomlContent = TOML.stringify({
			wokwi: {
				version: 1,
				firmware: hexPath,
				elf: elfPath,
			}
		});

		const diagramContent = await requestDiagramTemplateFromUser();

		if (!diagramContent) {
			return;
		}

		const { tomlUri, diagramUri } = await getSketchSimFileUris(sketchUri);
		await writeWorkspaceFile(tomlUri, tomlContent);
		await writeJsonWorkspaceFile(diagramUri, diagramContent);

		if (!usingActiveSketch && getConfig().get("autoSelectSketchOnCreateSim")) {
			await vscode.window.showTextDocument(sketchUri);
			await selectArduinoSketch(
				sketchUri,
				!!getConfig().get("autoCompileSketchOnCreateSim"),
				false,
				arduinoConfigUri,
				arduinoConfig,
			);
		}

		await configureWokwiTomlFirmwarePaths(buildTargetUri, sketchUri);
	});
	context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() { }
