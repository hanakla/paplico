import type { AutomationScript } from "./types";

export const BUILTIN_AUTOMATION_SCRIPTS: readonly AutomationScript[] = [
	{
		id: "builtin:sequential-rename",
		name: "Sequential Rename",
		description:
			"Rename the selected objects in their current selection order.",
		origin: "builtin",
		source: `let selected = paplico.editor.selection
guard selected.count > 0 else { return }

for i in 0..<selected.count {
	selected[i].name = "Object $(i + 1)"
}

print("Renamed $(selected.count) objects")
`,
	},
	{
		id: "builtin:random-transform",
		name: "Random Transform",
		description: "Randomly offset and rotate the selected objects.",
		origin: "builtin",
		source: `let selected = paplico.editor.selection
guard selected.count > 0 else { return }

for object in selected {
	object.transform.x += random() * 100 - 50
	object.transform.y += random() * 100 - 50
	object.transform.rotation += random() * 30 - 15
}

print("Transformed $(selected.count) objects")
`,
	},
	{
		id: "builtin:round-coordinates",
		name: "Round Coordinates",
		description: "Round the selected objects' positions to whole coordinates.",
		origin: "builtin",
		source: `let selected = paplico.editor.selection
guard selected.count > 0 else { return }

for object in selected {
	object.transform.x = round(object.transform.x)
	object.transform.y = round(object.transform.y)
}

print("Rounded $(selected.count) object positions")
`,
	},
	{
		id: "builtin:replace-selected-text",
		name: "Replace Text in Selection",
		description:
			"Find and replace text in selected text objects without changing their styles.",
		origin: "builtin",
		source: `let selected = paplico.editor.selection
guard selected.count > 0 else { return }
guard let search = await paplico.prompt.string(message: "Text to find", defaultValue: "") else { return }
guard search.isEmpty == false else { return }
guard let replacement = await paplico.prompt.string(message: "Replacement text", defaultValue: "") else { return }

var replacementCount = 0
for object in selected {
	replacementCount += replaceText(
		object: object,
		search: search,
		replacement: replacement
	)
}

print("Replaced $(replacementCount) occurrences")

fn replaceText(object: ArtObject, search: String, replacement: String) -> Number {
	guard let content = object.content else { return 0 }

	var replacementCount = 0
	var paragraphs = content.paragraphs
	for paragraphIndex in 0..<paragraphs.count {
		let result = replaceRuns(
			runs: paragraphs[paragraphIndex].runs,
			search: search,
			replacement: replacement
		)
		paragraphs[paragraphIndex].runs = result.runs
		replacementCount += result.count
	}
	content.paragraphs = paragraphs
	return replacementCount
}

fn replaceRuns(runs: [TextRun], search: String, replacement: String) -> ReplacementResult {
	let needle = search.split(separator: "")
	guard needle.count > 0 else {
		return ReplacementResult(runs: runs, count: 0)
	}

	var characters: [String] = []
	var runIndexes: [Number] = []
	var outputTexts: [String] = []
	for runIndex in 0..<runs.count {
		outputTexts.append(element: "")
		for character in runs[runIndex].text.split(separator: "") {
			characters.append(element: character)
			runIndexes.append(element: runIndex)
		}
	}

	var replacementCount = 0
	var characterIndex = 0
	while characterIndex < characters.count {
		guard matchesAt(
			characters: characters,
			needle: needle,
			index: characterIndex
		) else {
			let runIndex = runIndexes[characterIndex]
			outputTexts[runIndex] += characters[characterIndex]
			characterIndex += 1
			continue
		}

		let matchEnd = characterIndex + needle.count
		let replacementCharacters = replacement.split(separator: "")
		var replacementIndex = 0
		var matchedCharacterIndex = characterIndex
		while matchedCharacterIndex < matchEnd {
			let runIndex = runIndexes[matchedCharacterIndex]
			var runCharacterCount = 0
			while matchedCharacterIndex < matchEnd && runIndexes[matchedCharacterIndex] == runIndex {
				runCharacterCount += 1
				matchedCharacterIndex += 1
			}

			var assignedCount = 0
			while assignedCount < runCharacterCount && replacementIndex < replacementCharacters.count {
				outputTexts[runIndex] += replacementCharacters[replacementIndex]
				assignedCount += 1
				replacementIndex += 1
			}
		}

		let lastRunIndex = runIndexes[matchEnd - 1]
		while replacementIndex < replacementCharacters.count {
			outputTexts[lastRunIndex] += replacementCharacters[replacementIndex]
			replacementIndex += 1
		}

		characterIndex = matchEnd
		replacementCount += 1
	}

	var replacedRuns = runs
	for runIndex in 0..<replacedRuns.count {
		replacedRuns[runIndex].text = outputTexts[runIndex]
	}
	return ReplacementResult(runs: replacedRuns, count: replacementCount)
}

fn matchesAt(characters: [String], needle: [String], index: Number) -> Bool {
	guard index + needle.count <= characters.count else { return false }

	for needleIndex in 0..<needle.count {
		guard characters[index + needleIndex] == needle[needleIndex] else {
			return false
		}
	}
	return true
}

struct ReplacementResult {
	let runs: [TextRun]
	let count: Number
}
`,
	},
	{
		id: "builtin:select-text-by-content",
		name: "Select Text by Content",
		description:
			"Search text objects for a string and select every match across the document.",
		origin: "builtin",
		source: `guard let search = await paplico.prompt.string(message: "Text to find", defaultValue: "") else { return }
guard search.isEmpty == false else { return }

let objects = paplico.activeDocument.artObjects()
var matchedIds: [String] = []
for object in objects {
	guard let content = object.content else { continue }

	var fullText = ""
	for paragraph in content.paragraphs {
		for run in paragraph.runs {
			fullText += run.text
		}
	}

	guard fullText.contains(needle: search) else { continue }
	matchedIds.append(element: object.uid)
}

paplico.editor.select(uids: matchedIds)
print("Selected $(matchedIds.count) text objects containing: $(search)")
`,
	},
	{
		id: "builtin:swap-positions",
		name: "Swap Positions",
		description: "Exchange the positions of exactly two selected objects.",
		origin: "builtin",
		source: `let selected = paplico.editor.selection
guard selected.count == 2 else { return }

let firstX = selected[0].transform.x
let firstY = selected[0].transform.y
selected[0].transform.x = selected[1].transform.x
selected[0].transform.y = selected[1].transform.y
selected[1].transform.x = firstX
selected[1].transform.y = firstY

print("Swapped object positions")
`,
	},
] as const;
