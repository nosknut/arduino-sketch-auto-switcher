import * as TOML from '@iarna/toml';
import * as child_process from "child_process";
import { Socket } from 'net';
import { basename, dirname, join, sep as pathSeparator, relative, resolve as resolvePath } from 'path';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { WebSocket, WebSocketServer } from 'ws';

const channel = vscode.window.createOutputChannel("Arduino Sketch Auto Switcher");
let serialSocket: Socket | null = null;
let webSocketServer: WebSocketServer | null = null;

type WokWiToml = {
	wokwi: {
		version: number;
		firmware: string;
		elf: string;
		rfc2217ServerPort?: number;
		webSocketServerPort?: number;
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

async function deleteFirmware(buildTargetUri: vscode.Uri, isEsp: boolean) {
	const firmware = await findWorkspaceFile(
		new vscode.RelativePattern(buildTargetUri, isEsp ? "*.bin" : "*.hex")
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

async function readWorkspaceFile(uri: vscode.Uri) {
	const document = await vscode.workspace.openTextDocument(uri);
	return document.getText();
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

function getAbsoluteFirmwarePaths(buildTargetUri: vscode.Uri, sketchUri: vscode.Uri, isEsp: boolean) {
	const sketchName = getWorkspaceFileName(sketchUri);

	return {
		hexPath: vscode.Uri.joinPath(buildTargetUri, sketchName + (isEsp ? ".bin" : ".hex")),
		elfPath: vscode.Uri.joinPath(buildTargetUri, `${sketchName}.elf`),
	};
}

async function getFirmwarePaths(buildTargetUri: vscode.Uri, sketchUri: vscode.Uri, isEsp: boolean) {
	const sketchDirUri = getWorkspaceFileDirectory(sketchUri);
	const { hexPath, elfPath } = getAbsoluteFirmwarePaths(buildTargetUri, sketchUri, isEsp);

	return {
		hexPath: getRelativePath(sketchDirUri, hexPath),
		elfPath: getRelativePath(sketchDirUri, elfPath),
	};
}

function getLibrariesTxtUri(sketchUri: vscode.Uri) {
	const sketchDirUri = getWorkspaceFileDirectory(sketchUri);

	return vscode.Uri.joinPath(sketchDirUri, `libraries.txt`);
}

async function updateToml(tomlFileUri: vscode.Uri, hexFilePath: string, elfFilePath: string) {
	const toml = await getTomlWorkspaceFile(tomlFileUri);
	if (toml?.wokwi) {
		const original = TOML.stringify(toml);
		toml.wokwi.firmware = hexFilePath;
		toml.wokwi.elf = elfFilePath;
		const updated = TOML.stringify(toml);

		if (updated !== original) {
			await writeWorkspaceFile(tomlFileUri, TOML.stringify(toml));
		}
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

async function getTomlWorkspaceFile(tomlUri: vscode.Uri) {
	const tomlFile = await readWorkspaceFile(tomlUri);

	try {
		return TOML.parse(tomlFile) as WokWiToml;
	} catch (e) {
		console.error(e);
	}
}

async function setArduinoConfig(arduinoConfigUri: vscode.Uri, arduinoConfig: ArduinoConfig) {
	// TODO: For some reason this is not working.
	// The Arduino extension still analyzes the
	// sketch despite the setting being set to false
	// Force the Arduino Extension to not analyze the sketch on change
	await runWithoutSetting('arduino', 'analyzeOnSettingChange', async () => {
		await writeJsonWorkspaceFile(arduinoConfigUri, arduinoConfig);
	});
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
	output?: string,
	sketch?: string,
	board?: string,
};

async function getWorkspaceJsonFile<T>(uri: vscode.Uri) {
	const doc = await readWorkspaceFile(uri);
	return JSON.parse(doc) as T;
}

/**
 * Updates the default Arduino output path in arduino.json if it is not set
 * @returns true if the output path was updated
 */
async function setDefaultArduinoOutput(arduinoConfig: ArduinoConfig) {
	if (!arduinoConfig.output) {
		arduinoConfig.output = getConfig().get("defaultArduinoOutput") || "";
		vscode.window.showInformationMessage('Updated build output path in arduino.json');
		return true;
	}

	return false;
}

function getArduinoBuildTargetUri(workspaceUri: vscode.Uri, buildTarget: string) {
	return vscode.Uri.joinPath(
		workspaceUri,
		buildTarget,
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

export function trim(value: any) {
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			value[i] = trim(value[i]);
		}
	} else if (typeof value === "string") {
		value = value.trim();
	}
	return value;
}


/**
 * If given an string, splits the string on commas. If given an array, returns
 * the array. All strings in the output are trimmed.
 * @param value String or string array to convert.
 * @returns Array of strings split from the input.
 */
export function toStringArray(value: string | string[]): string[] {
	if (value) {
		let result: string[];

		if (typeof value === "string") {
			result = value.split(",");
		} else {
			result = <string[]>value;
		}

		return trim(result);
	}

	return [];
}

function getAdditionalUrls(): string[] {
	const value = vscode.workspace
		.getConfiguration()
		.get<string | string[]>("arduino.additionalUrls");

	if (!value) {
		return [];
	}

	return toStringArray(value);
}

/**
 * Send a command to arduino
 * @param {string} command - base command path (either Arduino IDE or CLI)
 * @param {vscode.OutputChannel} outputChannel - output display channel
 * @param {string[]} [args=[]] - arguments to pass to the command
 * @param {any} [options={}] - options and flags for the arguments
 * @param {(string) => {}} - callback for stdout text
 */
export function spawn(
	command: string,
	args: string[] = [],
	options: child_process.SpawnOptions = {},
	output?: {
		channel?: vscode.OutputChannel,
		stdout?: (s: string) => void,
		stderr?: (s: string) => void
	},
): Thenable<object> {
	return new Promise((resolve, reject) => {
		options.cwd = options.cwd || resolvePath(join(__dirname, ".."));
		const child = child_process.spawn(command, args, options);

		if (output) {
			if (output.channel || output.stdout) {
				child.stdout?.on("data", (data: Buffer) => {
					const decoded = data.toString();
					if (output.stdout) {
						output.stdout(decoded);
					}
					if (output.channel) {
						output.channel.append(decoded);
					}
				});
			}
			if (output.channel || output.stderr) {
				child.stderr?.on("data", (data: Buffer) => {
					const decoded = data.toString();
					if (decoded.toLowerCase().includes("error")) {
						vscode.window.showErrorMessage(decoded);
					}
					if (output.stderr) {
						output.stderr(decoded);
					}
					if (output.channel) {
						output.channel.append(decoded);
					}
				});
			}
		}

		child.on("error", (error) => reject({ error }));

		// It's important to use use the "close" event instead of "exit" here.
		// There could still be buffered data in stdout or stderr when the
		// process exits that we haven't received yet.
		child.on("close", (code) => {
			if (code === 0) {
				resolve({ code });
			} else {
				reject({ code });
			}
		});
	});
}

async function installLibrary(libName: string, version: string = "") {
	const args = ["lib", "install", `${libName}${version && "@" + version}`];

	const additionalUrls = getAdditionalUrls();
	try {

		await spawn(
			"arduino-cli",
			args.concat(["--additional-urls", additionalUrls.join(",")]),
			undefined,
			{ channel });
	} catch (e) {
		// Do nothing. Error should get printed in the output channel.
	}
}

function parseLibrariesTxt(content: string) {
	return content
		.split('\n')
		.map(line => line.trim())
		.filter(line => line.length && (line[0] !== '#'));
}

async function installLibrariesTxt(librariesTxtUri: vscode.Uri) {
	if (await workspaceFileExists(librariesTxtUri)) {
		const libraries = parseLibrariesTxt(await readWorkspaceFile(librariesTxtUri));

		for (const lib of libraries) {
			const [libName, version] = lib.split('@');
			await installLibrary(libName, version);
		}
	}
}

async function selectArduinoSketch(
	uri: vscode.Uri,
	verify: boolean,
	verifyWithoutChanges: boolean,
	arduinoConfigUri: vscode.Uri,
	arduinoConfig: ArduinoConfig,
	workspaceUri: vscode.Uri,
) {
	const status = {
		verified: false,
		updatedSketch: false,
		updatedOutput: false,
		updatedBoardType: false,
	};

	if (!fileIsSketch(uri)) {
		vscode.window.showErrorMessage('Selected file is not an Arduino sketch');
		return status;
	}

	const sketchAlreadySelected = await sketchIsSelected(uri, arduinoConfig);

	if (!sketchAlreadySelected) {
		status.updatedSketch = true;
		arduinoConfig.sketch = getHumanReadableWorkspacePath(uri);
		// vscode.window.showInformationMessage(`Selected ${getWorkspaceFileName(uri)}`);
	}

	if (await setDefaultArduinoOutput(arduinoConfig)) {
		status.updatedOutput = true;
	}

	if (await sketchHasSimulation(uri)) {
		const { diagramUri } = await getSketchSimFileUris(uri);

		const diagram = await readWorkspaceFile(diagramUri);

		const simBoardType = getSimBoardType(diagram);

		if (simBoardType !== arduinoConfig.board) {
			if (simBoardType) {
				const changeBoardType = await vscode.window.showWarningMessage(
					`This simulation uses an ${getSimBoardTypeName(simBoardType)}. Would you like to select this board type?`,
					'Yes',
					'No',
				);

				if (changeBoardType === 'Yes') {
					arduinoConfig.board = simBoardType;
					status.updatedBoardType = true;
				}
			}
		}
	}

	const sketchLibrariesUri = getLibrariesTxtUri(uri);
	const projectLibrariesUri = getLibrariesTxtUri(workspaceUri);

	await installLibrariesTxt(sketchLibrariesUri);
	await installLibrariesTxt(projectLibrariesUri);

	const somethingChanged = status.updatedOutput || status.updatedSketch || status.updatedBoardType;

	if (somethingChanged) {
		await setArduinoConfig(arduinoConfigUri, arduinoConfig);
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
	return tomlExists && diagramExists;
}

function getSimBoardType(diagram: string) {
	if (diagram.includes("wokwi-arduino-uno")) {
		return "arduino:avr:uno";
	}

	if (diagram.includes("wokwi-arduino-mega")) {
		return "arduino:avr:megaADK";
	}

	if (diagram.includes("wokwi-esp32")) {
		return "esp32:esp32:esp32";
	}
	return null;
}

function getSimBoardTypeName(boardType: string) {
	switch (boardType) {
		case "arduino:avr:uno":
			return "Arduino Uno";
		case "arduino:avr:megaADK":
			return "Arduino Mega";
		case "esp32:esp32:esp32":
			return "ESP32";
		default:
			return boardType;
	}
}

async function configureWokwiTomlFirmwarePaths(
	buildTargetUri: vscode.Uri,
	sketchUri: vscode.Uri,
	showSimSwitchMessage: boolean,
) {
	const exists = await sketchHasSimulation(sketchUri);
	if (!exists) {
		return;
	}

	const { tomlUri, diagramUri } = await getSketchSimFileUris(sketchUri);

	const diagram = await readWorkspaceFile(diagramUri);

	const firmwarePaths = await getFirmwarePaths(buildTargetUri, sketchUri, simIsEsp32(diagram));

	if (!firmwarePaths) {
		return;
	}

	const { hexPath, elfPath } = firmwarePaths;
	await updateToml(
		tomlUri,
		hexPath,
		elfPath,
	);

	if (showSimSwitchMessage) {
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
}

function fileIsSketch(uri: vscode.Uri) {
	return uri.path.endsWith('.ino');
}

const templates = {
	uno: {
		label: "UNO",
		template: {
			"version": 1,
			"author": "wokwi",
			"editor": "wokwi",
			"parts": [{ "type": "wokwi-arduino-uno", "id": "uno", "top": 0, "left": 0, "attrs": {} }],
			"connections": [],
			"dependencies": {}
		},
	},
	uno1Button: {
		label: "UNO with 1 button",
		template: {
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
	},
	uno1Led: {
		label: "UNO with 1 LED",
		template: {
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
	},
	uno1Button1Led: {
		label: "UNO with 1 button and 1 LED",
		template: {
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
	},
	uno2Buttons2Leds: {
		label: "UNO with 2 buttons and 2 LEDs",
		template: {
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
	},
	uno1RgbLed: {
		label: "UNO with 1 RGB LED",
		template: {
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
					"type": "wokwi-resistor",
					"id": "r2",
					"top": 91.2,
					"left": -0.55,
					"rotate": 90,
					"attrs": { "value": "1000" }
				},
				{
					"type": "wokwi-rgb-led",
					"id": "rgb1",
					"top": 99.4,
					"left": 4.9,
					"rotate": 180,
					"attrs": { "common": "cathode" }
				}
			],
			"connections": [
				["uno:5V", "bb1:tp.24", "red", ["v-21.57", "h185.23"]],
				["uno:GND.2", "bb1:tn.25", "black", ["v-33.17", "h191.11"]],
				["bb1:29t.a", "bb1:tp.24", "red", ["v0"]],
				["bb1:7t.a", "uno:5", "blue", ["v-59.27", "h-25.93"]],
				["r2:1", "bb1:tn.7", "", ["$bb"]],
				["r2:2", "bb1:9t.d", "", ["$bb"]],
				["rgb1:R", "bb1:10t.e", "", ["$bb"]],
				["rgb1:COM", "bb1:9t.d", "", ["$bb"]],
				["rgb1:G", "bb1:8t.e", "", ["$bb"]],
				["rgb1:B", "bb1:7t.e", "", ["$bb"]],
				["bb1:8t.a", "uno:6", "green", ["v-66.98", "h-35.56"]],
				["bb1:10t.a", "uno:9", "red", ["v-76.65", "h-39.93"]]
			],
			"dependencies": {}
		},
	},
	uno1Button1RgbLed: {
		label: "UNO with 1 button and 1 RGB LED",
		template: {
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
					"type": "wokwi-resistor",
					"id": "r2",
					"top": 91.2,
					"left": -0.55,
					"rotate": 90,
					"attrs": { "value": "1000" }
				},
				{
					"type": "wokwi-rgb-led",
					"id": "rgb1",
					"top": 99.4,
					"left": 4.9,
					"rotate": 180,
					"attrs": { "common": "cathode" }
				}
			],
			"connections": [
				["uno:5V", "bb1:tp.24", "red", ["v-21.57", "h185.23"]],
				["uno:GND.2", "bb1:tn.25", "black", ["v-33.17", "h191.11"]],
				["r1:2", "uno:2", "orange", ["h0"]],
				["bb1:4t.a", "bb1:tp.3", "red", ["v0"]],
				["bb1:29t.a", "bb1:tp.24", "red", ["v0"]],
				["bb1:7t.a", "uno:5", "blue", ["v-59.27", "h-25.93"]],
				["btn1:1.l", "bb1:4t.e", "", ["$bb"]],
				["btn1:2.l", "bb1:2t.e", "", ["$bb"]],
				["btn1:1.r", "bb1:4b.j", "", ["$bb"]],
				["btn1:2.r", "bb1:2b.j", "", ["$bb"]],
				["r1:1", "bb1:tn.1", "", ["$bb"]],
				["r1:2", "bb1:2t.d", "", ["$bb"]],
				["r2:1", "bb1:tn.7", "", ["$bb"]],
				["r2:2", "bb1:9t.d", "", ["$bb"]],
				["rgb1:R", "bb1:10t.e", "", ["$bb"]],
				["rgb1:COM", "bb1:9t.d", "", ["$bb"]],
				["rgb1:G", "bb1:8t.e", "", ["$bb"]],
				["rgb1:B", "bb1:7t.e", "", ["$bb"]],
				["bb1:8t.a", "uno:6", "green", ["v-66.98", "h-35.56"]],
				["bb1:10t.a", "uno:9", "red", ["v-76.65", "h-39.93"]]
			],
			"dependencies": {}
		},
	},
};

async function requestDiagramTemplateFromUser() {
	const sketchType = await vscode.window.showQuickPick(
		Object.values(templates).map((template) => ({
			label: template.label,
			description: template.label,
		})), {
		placeHolder: "Select a sketch type",
		matchOnDescription: true,
	});

	if (!sketchType) {
		return;
	}

	const diagram = Object.values(templates)
		.find(template => template.label === sketchType.label)?.template;

	if (!diagram) {
		vscode.window.showErrorMessage('Unable to find diagram template');
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

	if (await setDefaultArduinoOutput(arduinoConfig)) {
		await setArduinoConfig(arduinoConfigUri, arduinoConfig);
	}

	if (!arduinoConfig.output) {
		return;
	}

	const buildTargetUri = getArduinoBuildTargetUri(workspaceUri, arduinoConfig.output);

	return {
		arduinoConfigUri,
		arduinoConfig,
		buildTargetUri,
		workspaceUri,
	};
}

function startWebSocketServer(port: number, onError: () => void) {
	const server = new WebSocketServer({ port });

	server.on('listening', () => {
		channel.append('Serial Port is available on WebSocket: ws://localhost:' + port + '\n');
		vscode.window.showInformationMessage('Wokwi: Serial Port is available on WebSocket: ws://localhost:' + port);
	});

	server.on('connection', (socket) => {
		channel.append(`Client connected to websocket\n`);
		vscode.window.showInformationMessage('Wokwi: Client connected to WebSocket Serial Port');

		socket.on('message', (data) => {
			serialSocket?.write(data.toString());
		});

		socket.on('close', () => {
			channel.append(`Client disconnected from websocket\n`);
			vscode.window.showWarningMessage('Wokwi: Client disconnected from WebSocket Serial Port');
		});
	});

	server.on('close', () => {
		channel.append(`Websocket server closed\n`);
		vscode.window.showWarningMessage('Wokwi: WebSocket Serial Port closed');
	});

	server.on('error', (error) => {
		channel.append(`Websocket server error: ${error}\n`);
		vscode.window.showErrorMessage(`Wokwi: WebSocket Serial Port error: ${error}`);
		server.close();
		onError();
	});

	return server;
}

function connectSerialClient(port: number) {
	if (!serialSocket?.connecting) {
		serialSocket?.connect(port, 'localhost', () => {
			channel.append(`Connected to Serial Port: ${port}\n`);
		});
	}
}

function startSerialClient(port: number, onError: () => void) {
	const socket = new Socket({ writable: true, readable: true });

	connectSerialClient(port);

	socket.on('data', (data) => {
		const value = data.toString();
		webSocketServer?.clients.forEach((client) => {
			client.send(value);
		});
	});

	socket.on('close', () => {
		channel.append(`Serial Port ${port} disconnected\n`);
	});

	socket.on('error', (error) => {
		channel.append(`Serial Port ${port} error: ${error}\n`);
		vscode.window.showErrorMessage(`Wokwi: Serial Port error: ${error}`);
		socket.destroy();
		onError();
	});

	return socket;
}

function startSerialProxy({ tcpPort, webSocketPort }: { tcpPort: number, webSocketPort: number }) {
	if (!webSocketServer) {
		webSocketServer = startWebSocketServer(webSocketPort, () => webSocketServer = null);
	}

	if (!serialSocket) {
		serialSocket = startSerialClient(tcpPort, () => serialSocket = null);
	}

	connectSerialClient(tcpPort);
}

async function getSerialProxyConfig(sketchUri?: vscode.Uri) {
	if (!sketchUri) {
		return;
	}

	if (!await sketchHasSimulation(sketchUri)) {
		return;
	}

	const { tomlUri } = await getSketchSimFileUris(sketchUri);

	const toml = await getTomlWorkspaceFile(tomlUri);
	const tcpPort = toml?.wokwi?.rfc2217ServerPort;
	const webSocketPort = toml?.wokwi?.webSocketServerPort;

	if (!tcpPort || !webSocketPort) {
		return;
	}

	return { tcpPort, webSocketPort };
}

// https://stackoverflow.com/questions/70989176/is-there-a-vs-code-api-function-to-return-all-open-text-editors-and-their-viewco
async function getWokwiSimulatorTab() {
	for (const tabGroup of vscode.window.tabGroups.all) {
		for (const tab of tabGroup.tabs) {
			if (tab.label === 'Wokwi Simulator') {
				return tab;
			}
		}
	}
}

function sleep(durationMs: number) {
	return new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function retry(fn: () => Promise<boolean>, intervalMs: number, timeoutMs: number) {
	let retries = 0;

	while (true) {
		if (await fn()) {
			return true;
		}

		if (retries * intervalMs > timeoutMs) {
			return false;
		}

		retries++;
		await sleep(intervalMs);
	}
}

function simIsEsp32(diagram: string) {
	return getSimBoardType(diagram) === "esp32:esp32:esp32";
}

async function createTempWokwiSimulationFiles(sketchUri: vscode.Uri) {
	if (!await sketchHasSimulation(sketchUri)) {
		return;
	}

	const setupResult = await standardSetup(sketchUri);

	if (!setupResult) {
		return;
	}

	const {
		buildTargetUri,
		workspaceUri,
	} = setupResult;

	if (!workspaceUri) {
		return;
	}

	const { diagramUri, tomlUri } = await getSketchSimFileUris(sketchUri);
	const tempSimDirUri = vscode.Uri.joinPath(workspaceUri, '.wokwi', 'temp', 'config');

	await vscode.workspace.fs.createDirectory(tempSimDirUri);

	const tempDiagramUri = vscode.Uri.joinPath(tempSimDirUri, 'diagram.json');
	const tempTomlUri = vscode.Uri.joinPath(tempSimDirUri, 'wokwi.toml');

	await vscode.workspace.fs.copy(diagramUri, tempDiagramUri, { overwrite: true });
	await vscode.workspace.fs.copy(tomlUri, tempTomlUri, { overwrite: true });

	const diagram = await readWorkspaceFile(tempDiagramUri);

	const firmwarePaths = await getAbsoluteFirmwarePaths(buildTargetUri, sketchUri, simIsEsp32(diagram));

	if (!firmwarePaths) {
		return;
	}

	const { hexPath, elfPath } = firmwarePaths;
	await updateToml(
		tempTomlUri,
		getRelativePath(tempSimDirUri, hexPath),
		getRelativePath(tempSimDirUri, elfPath),
	);
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
			const activeSketch = args || vscode.window.activeTextEditor?.document.uri;

			const portConfig = await getSerialProxyConfig(activeSketch);

			const simulatorTab = await getWokwiSimulatorTab();

			if (simulatorTab) {
				await vscode.window.tabGroups.close(simulatorTab);
			}

			await createTempWokwiSimulationFiles(activeSketch);

			await vscode.commands.executeCommand('wokwi-vscode.start');

			setTimeout(async () => {
				// Wait for the simulation to start
				await retry(async () => !!await getWokwiSimulatorTab(), 10, 10000);

				if (portConfig) {
					startSerialProxy(portConfig);
				}

				// Run this check in case the simulator fails to start
				const newSimulatorTab = await getWokwiSimulatorTab();

				if (newSimulatorTab?.isActive) {
					// Move the Wokwi simulator tab to the right
					await vscode.commands.executeCommand('moveActiveEditor', { to: 'right', by: 'group', value: 2 });
					// Bring focus back to the sketch
					// https://stackoverflow.com/questions/72720659/vscode-how-to-focus-to-an-editor
					await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
				}
			}, 100);
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
				workspaceUri,
			} = setupResult;

			if (getConfig().get("autoSelectSketchOnSave")) {
				await selectArduinoSketch(
					sketchUri,
					!!getConfig().get("autoVerifySketchOnSave"),
					true,
					arduinoConfigUri,
					arduinoConfig,
					workspaceUri,
				);
			}

			if (getConfig().get("autoConfigureWokwiTomlFirmwarePathOnSketchSave")) {
				await configureWokwiTomlFirmwarePaths(buildTargetUri, sketchUri, false);
			}

			if (getConfig().get("autoRestartSimulationOnSave")) {
				if (await sketchHasSimulation(sketchUri)) {
					await vscode.commands.executeCommand('arduino-sketch-auto-switcher.startWokwiSimulation', sketchUri);
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
				workspaceUri,
			} = setupResult;

			if (getConfig().get("autoSelectSketchOnOpen")) {
				await selectArduinoSketch(
					sketchUri,
					!!getConfig().get("autoCompileSketchOnOpen"),
					false,
					arduinoConfigUri,
					arduinoConfig,
					workspaceUri,
				);
			}

			if (getConfig().get("autoConfigureWokwiTomlFirmwarePathOnSketchOpen")) {
				await configureWokwiTomlFirmwarePaths(buildTargetUri, sketchUri, false);
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
			vscode.window.showErrorMessage('No sketch is open');
			return;
		}

		if (usingActiveSketch && !fileIsSketch(sketchUri)) {
			vscode.window.showErrorMessage('You must open a .ino file to create a simulation');
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
			workspaceUri,
		} = setupResult;

		const diagramContent = await requestDiagramTemplateFromUser();

		if (!diagramContent) {
			return;
		}
		const { hexPath, elfPath } = await getFirmwarePaths(buildTargetUri, sketchUri, simIsEsp32(JSON.stringify(diagramContent)));

		const tomlContent = TOML.stringify({
			wokwi: {
				version: 1,
				firmware: hexPath,
				elf: elfPath,
			}
		});

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
				workspaceUri,
			);
		}

		await configureWokwiTomlFirmwarePaths(buildTargetUri, sketchUri, false);
	});
	context.subscriptions.push(disposable);

	context.subscriptions.push({
		dispose() {
			webSocketServer?.close();
			webSocketServer = null;
		}
	});

	context.subscriptions.push({
		dispose() {
			serialSocket?.destroy();
			serialSocket = null;
		}
	});
}

// This method is called when your extension is deactivated
export function deactivate() { }
