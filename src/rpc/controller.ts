import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	emptyAnswer,
	isAnswerEmpty,
	isOptionSelected,
	saveCustomText,
	saveOptionNote,
	saveQuestionNote,
	setSingleSelection,
	toggleSelection,
} from "../state/answers.ts";
import { toAskResult } from "../state/result.ts";
import type {
	AskDisplayOption,
	AskQuestion,
	AskResult,
	AskState,
	AskStateAnswer,
} from "../types.ts";

type RpcUi = Pick<
	ExtensionContext["ui"],
	"confirm" | "editor" | "input" | "select"
>;

interface RpcStepResult {
	cancelled: boolean;
	state: AskState;
}

interface SelectAction {
	kind:
		| "cancel"
		| "custom-editor"
		| "custom-input"
		| "finish"
		| "option"
		| "skip";
	label: string;
	optionIndex?: number;
}

interface NoteAction {
	kind:
		| "cancel"
		| "continue"
		| "option-note"
		| "question-editor"
		| "question-input";
	label: string;
	optionValue?: string;
}

const CANCEL_LABEL = "Cancel ask";
const CONTINUE_LABEL = "Continue";
const CUSTOM_EDITOR_LABEL = "Write or edit a multiline answer…";
const CUSTOM_INPUT_LABEL = "Type or edit a short answer…";
const FINISH_SELECTION_LABEL = "Finish selection";

export async function runRpcAskFlow(
	ctx: { ui: RpcUi },
	initialState: AskState
): Promise<AskResult> {
	let state = initialState;

	for (const [questionIndex] of state.questions.entries()) {
		const answerStep = await askQuestion(ctx.ui, state, questionIndex);
		state = answerStep.state;
		if (answerStep.cancelled) {
			return cancelledResult(state);
		}

		const noteStep = await askForOptionalNotes(ctx.ui, state, questionIndex);
		state = noteStep.state;
		if (noteStep.cancelled) {
			return cancelledResult(state);
		}
	}

	return toAskResult({
		...state,
		activeTabIndex: state.questions.length,
		completed: true,
	});
}

async function askQuestion(
	ui: RpcUi,
	state: AskState,
	questionIndex: number
): Promise<RpcStepResult> {
	const question = state.questions[questionIndex];
	if (!question) {
		return { cancelled: false, state };
	}
	if (question.type === "multi") {
		return await askMultiQuestion(ui, state, question, questionIndex);
	}
	return await askSingleQuestion(ui, state, question, questionIndex);
}

async function askSingleQuestion(
	ui: RpcUi,
	state: AskState,
	question: AskQuestion,
	questionIndex: number
): Promise<RpcStepResult> {
	const binaryOptions = getYesNoOptions(question);
	const actions: SelectAction[] = binaryOptions
		? [
				{
					kind: "option",
					label: formatYesNoAction(binaryOptions),
				},
			]
		: question.options
				.filter((option) => !option.freeform)
				.map((option, optionIndex) => ({
					kind: "option" as const,
					label: formatOption(option, optionIndex),
					optionIndex,
				}));
	appendCommonActions(actions, question);

	const action = await selectAction(
		ui,
		formatTitle(state, question, questionIndex),
		actions
	);
	return applySingleAction({
		action,
		binaryOptions,
		question,
		questionIndex,
		state,
		ui,
	});
}

async function applySingleAction(args: {
	action: SelectAction | undefined;
	binaryOptions: YesNoOptions | undefined;
	question: AskQuestion;
	questionIndex: number;
	state: AskState;
	ui: RpcUi;
}): Promise<RpcStepResult> {
	const { action, binaryOptions, question, questionIndex, state, ui } = args;
	if (!action || action.kind === "cancel") {
		return { cancelled: true, state };
	}
	if (action.kind === "skip") {
		return { cancelled: false, state: clearAnswer(state, question.id) };
	}
	if (action.kind === "custom-input" || action.kind === "custom-editor") {
		return askForCustomAnswer(
			ui,
			state,
			question,
			questionIndex,
			action.kind === "custom-editor"
		);
	}
	if (action.kind !== "option") {
		return { cancelled: true, state };
	}

	const optionIndex = await resolveSingleOptionIndex({
		action,
		binaryOptions,
		question,
		questionIndex,
		state,
		ui,
	});
	return selectSingleOption(state, question, optionIndex);
}

async function resolveSingleOptionIndex(args: {
	action: SelectAction;
	binaryOptions: YesNoOptions | undefined;
	question: AskQuestion;
	questionIndex: number;
	state: AskState;
	ui: RpcUi;
}): Promise<number | undefined> {
	if (!args.binaryOptions) {
		return args.action.optionIndex;
	}
	const confirmed = await args.ui.confirm(
		formatTitle(args.state, args.question, args.questionIndex, "Yes / No"),
		formatYesNoMessage(args.binaryOptions)
	);
	return confirmed
		? args.binaryOptions.yes.optionIndex
		: args.binaryOptions.no.optionIndex;
}

function selectSingleOption(
	state: AskState,
	question: AskQuestion,
	optionIndex: number | undefined
): RpcStepResult {
	const option =
		optionIndex === undefined ? undefined : question.options[optionIndex];
	if (!option || optionIndex === undefined) {
		return { cancelled: true, state };
	}
	return {
		cancelled: false,
		state: updateAnswer(state, question.id, (answer) =>
			setSingleSelection(answer, option, optionIndex)
		),
	};
}

async function askMultiQuestion(
	ui: RpcUi,
	initialState: AskState,
	question: AskQuestion,
	questionIndex: number
): Promise<RpcStepResult> {
	let state = initialState;
	while (true) {
		const actions = createMultiActions(question, state.answers[question.id]);
		const action = await selectAction(
			ui,
			formatTitle(state, question, questionIndex, "Select all that apply"),
			actions
		);
		const actionResult = await applyMultiAction({
			action,
			question,
			questionIndex,
			state,
			ui,
		});
		if (actionResult.done) {
			return actionResult.step;
		}
		state = actionResult.state;
	}
}

function createMultiActions(
	question: AskQuestion,
	answer: AskStateAnswer | undefined
): SelectAction[] {
	const actions: SelectAction[] = question.options
		.filter((option) => !option.freeform)
		.map((option, optionIndex) => ({
			kind: "option" as const,
			label: formatOption(option, optionIndex, {
				selected: isOptionSelected(answer, option.value),
			}),
			optionIndex,
		}));
	actions.push({ kind: "finish", label: FINISH_SELECTION_LABEL });
	actions.push({
		kind: "custom-input",
		label: formatCustomAction(CUSTOM_INPUT_LABEL, answer),
	});
	actions.push({
		kind: "custom-editor",
		label: formatCustomAction(CUSTOM_EDITOR_LABEL, answer),
	});
	actions.push({ kind: "skip", label: formatSkipLabel(question) });
	actions.push({ kind: "cancel", label: CANCEL_LABEL });
	return actions;
}

type MultiActionResult =
	| { done: false; state: AskState }
	| { done: true; step: RpcStepResult };

async function applyMultiAction(args: {
	action: SelectAction | undefined;
	question: AskQuestion;
	questionIndex: number;
	state: AskState;
	ui: RpcUi;
}): Promise<MultiActionResult> {
	const { action, question, questionIndex, state, ui } = args;
	if (!action || action.kind === "cancel") {
		return { done: true, step: { cancelled: true, state } };
	}
	if (action.kind === "finish") {
		return { done: true, step: { cancelled: false, state } };
	}
	if (action.kind === "skip") {
		return {
			done: true,
			step: { cancelled: false, state: clearAnswer(state, question.id) },
		};
	}
	if (action.kind === "custom-input" || action.kind === "custom-editor") {
		const step = await askForCustomAnswer(
			ui,
			state,
			question,
			questionIndex,
			action.kind === "custom-editor"
		);
		return step.cancelled
			? { done: true, step }
			: { done: false, state: step.state };
	}
	return applyMultiOptionAction(state, question, action);
}

function applyMultiOptionAction(
	state: AskState,
	question: AskQuestion,
	action: SelectAction
): MultiActionResult {
	const optionIndex = action.optionIndex;
	const option =
		optionIndex === undefined ? undefined : question.options[optionIndex];
	if (!option || optionIndex === undefined) {
		return { done: true, step: { cancelled: true, state } };
	}
	return {
		done: false,
		state: updateAnswer(state, question.id, (currentAnswer) => {
			const nextAnswer = toggleSelection(currentAnswer, option, optionIndex);
			return {
				...nextAnswer,
				selected: [...nextAnswer.selected].sort(
					(left, right) => left.index - right.index
				),
			};
		}),
	};
}

async function askForCustomAnswer(
	ui: RpcUi,
	state: AskState,
	question: AskQuestion,
	questionIndex: number,
	multiline: boolean
): Promise<RpcStepResult> {
	const currentText = state.answers[question.id]?.customText;
	const title = formatTitle(
		state,
		question,
		questionIndex,
		multiline ? "Multiline answer" : "Short answer"
	);
	const value = multiline
		? await ui.editor(title, currentText ?? "")
		: await ui.input(title, formatInputPlaceholder(currentText));
	if (value === undefined) {
		return { cancelled: true, state };
	}

	return {
		cancelled: false,
		state: updateAnswer(state, question.id, (answer) =>
			saveCustomText(
				answer,
				value,
				question.type === "multi" ? "multi" : "single"
			)
		),
	};
}

async function askForOptionalNotes(
	ui: RpcUi,
	initialState: AskState,
	questionIndex: number
): Promise<RpcStepResult> {
	let state = initialState;
	const question = state.questions[questionIndex];
	if (!question) {
		return { cancelled: false, state };
	}

	while (true) {
		const answer = state.answers[question.id];
		const actions = createNoteActions(answer);
		const action = await selectNoteAction(
			ui,
			formatTitle(state, question, questionIndex, "Optional notes"),
			actions
		);
		const actionResult = await applyNoteAction({
			action,
			question,
			questionIndex,
			state,
			ui,
		});
		if (actionResult.done) {
			return actionResult.step;
		}
		state = actionResult.state;
	}
}

function appendCommonActions(
	actions: SelectAction[],
	question: AskQuestion
): void {
	actions.push({ kind: "custom-input", label: CUSTOM_INPUT_LABEL });
	actions.push({ kind: "custom-editor", label: CUSTOM_EDITOR_LABEL });
	actions.push({ kind: "skip", label: formatSkipLabel(question) });
	actions.push({ kind: "cancel", label: CANCEL_LABEL });
}

function createNoteActions(answer: AskStateAnswer | undefined): NoteAction[] {
	return [
		{ kind: "continue", label: CONTINUE_LABEL },
		{
			kind: "question-input",
			label: answer?.note
				? "Replace or clear the short question note…"
				: "Add a short question note…",
		},
		{
			kind: "question-editor",
			label: answer?.note
				? "Edit the question note in a multiline editor…"
				: "Add a multiline question note…",
		},
		...(answer?.selected ?? []).map((selection) => ({
			kind: "option-note" as const,
			optionValue: selection.value,
			label: answer?.optionNotes?.[selection.value]
				? `Edit note for selected option: ${compactText(selection.label)}…`
				: `Add note for selected option: ${compactText(selection.label)}…`,
		})),
		{ kind: "cancel", label: CANCEL_LABEL },
	];
}

type NoteActionResult =
	| { done: false; state: AskState }
	| { done: true; step: RpcStepResult };

async function applyNoteAction(args: {
	action: NoteAction | undefined;
	question: AskQuestion;
	questionIndex: number;
	state: AskState;
	ui: RpcUi;
}): Promise<NoteActionResult> {
	const { action, question, questionIndex, state, ui } = args;
	if (!action || action.kind === "cancel") {
		return { done: true, step: { cancelled: true, state } };
	}
	if (action.kind === "continue") {
		return { done: true, step: { cancelled: false, state } };
	}
	if (action.kind === "question-input") {
		return await editQuestionNote(ui, state, question, questionIndex, false);
	}
	if (action.kind === "question-editor") {
		return await editQuestionNote(ui, state, question, questionIndex, true);
	}
	return await editOptionNote(ui, state, question, questionIndex, action);
}

async function editQuestionNote(
	ui: RpcUi,
	state: AskState,
	question: AskQuestion,
	questionIndex: number,
	multiline: boolean
): Promise<NoteActionResult> {
	const currentNote = state.answers[question.id]?.note;
	const title = formatTitle(state, question, questionIndex, "Question note");
	const value = multiline
		? await ui.editor(title, currentNote ?? "")
		: await ui.input(title, formatNotePlaceholder(currentNote));
	if (value === undefined) {
		return { done: true, step: { cancelled: true, state } };
	}
	return {
		done: false,
		state: updateAnswer(state, question.id, (answer) =>
			saveQuestionNote(answer, value)
		),
	};
}

async function editOptionNote(
	ui: RpcUi,
	state: AskState,
	question: AskQuestion,
	questionIndex: number,
	action: NoteAction
): Promise<NoteActionResult> {
	const optionValue = action.optionValue;
	const option = question.options.find(
		(candidate) => candidate.value === optionValue
	);
	if (!(optionValue && option)) {
		return { done: true, step: { cancelled: true, state } };
	}
	const value = await ui.editor(
		formatTitle(
			state,
			question,
			questionIndex,
			`Note for ${compactText(option.label)}`
		),
		state.answers[question.id]?.optionNotes?.[optionValue] ?? ""
	);
	if (value === undefined) {
		return { done: true, step: { cancelled: true, state } };
	}
	return {
		done: false,
		state: updateAnswer(state, question.id, (answer) =>
			saveOptionNote(answer, optionValue, value)
		),
	};
}

async function selectAction(
	ui: RpcUi,
	title: string,
	actions: SelectAction[]
): Promise<SelectAction | undefined> {
	const selected = await ui.select(
		title,
		actions.map((action) => action.label)
	);
	return actions.find((action) => action.label === selected);
}

async function selectNoteAction(
	ui: RpcUi,
	title: string,
	actions: NoteAction[]
): Promise<NoteAction | undefined> {
	const selected = await ui.select(
		title,
		actions.map((action) => action.label)
	);
	return actions.find((action) => action.label === selected);
}

function updateAnswer(
	state: AskState,
	questionId: string,
	mutate: (answer: AskStateAnswer) => AskStateAnswer
): AskState {
	const nextAnswer = mutate(state.answers[questionId] ?? emptyAnswer());
	const answers = { ...state.answers };
	if (isAnswerEmpty(nextAnswer)) {
		delete answers[questionId];
	} else {
		answers[questionId] = nextAnswer;
	}
	return { ...state, answers };
}

function clearAnswer(state: AskState, questionId: string): AskState {
	if (!state.answers[questionId]) {
		return state;
	}
	const answers = { ...state.answers };
	delete answers[questionId];
	return { ...state, answers };
}

function cancelledResult(state: AskState): AskResult {
	return toAskResult({
		...state,
		cancelled: true,
		completed: true,
	});
}

function formatTitle(
	state: AskState,
	question: AskQuestion,
	questionIndex: number,
	suffix?: string
): string {
	const progress = `[${questionIndex + 1}/${state.questions.length}]`;
	const flowTitle = state.title ? `${compactText(state.title)} — ` : "";
	const detail = suffix ? ` — ${suffix}` : "";
	return `${progress} ${flowTitle}${compactText(question.label)}: ${compactText(question.prompt)}${detail}`;
}

function formatOption(
	option: AskDisplayOption,
	optionIndex: number,
	options: { selected?: boolean } = {}
): string {
	let marker = "";
	if (options.selected !== undefined) {
		marker = options.selected ? "[x] " : "[ ] ";
	}
	const description = option.description
		? ` — ${compactText(option.description)}`
		: "";
	const preview = option.preview
		? ` — Preview: ${compactText(option.preview)}`
		: "";
	return `${marker}${optionIndex + 1}. ${compactText(option.label)}${description}${preview}`;
}

function formatCustomAction(
	baseLabel: string,
	answer: AskStateAnswer | undefined
): string {
	if (!(answer?.customSelected && answer.customText?.trim())) {
		return `[ ] ${baseLabel}`;
	}
	return `[x] ${baseLabel} — Current: ${truncateText(answer.customText)}`;
}

function formatSkipLabel(question: AskQuestion): string {
	return question.required
		? "Skip this question (required is advisory)"
		: "Skip this question (optional)";
}

interface YesNoOptions {
	no: { option: AskQuestion["options"][number]; optionIndex: number };
	yes: { option: AskQuestion["options"][number]; optionIndex: number };
}

function getYesNoOptions(question: AskQuestion): YesNoOptions | undefined {
	if (question.type !== "single" || question.options.length !== 2) {
		return;
	}
	const yesIndex = question.options.findIndex((option) =>
		matchesBinaryToken(option, "yes")
	);
	const noIndex = question.options.findIndex((option) =>
		matchesBinaryToken(option, "no")
	);
	if (yesIndex < 0 || noIndex < 0 || yesIndex === noIndex) {
		return;
	}
	const yes = question.options[yesIndex];
	const no = question.options[noIndex];
	if (!(yes && no)) {
		return;
	}
	return {
		yes: { option: yes, optionIndex: yesIndex },
		no: { option: no, optionIndex: noIndex },
	};
}

function matchesBinaryToken(
	option: AskQuestion["options"][number],
	token: "yes" | "no"
): boolean {
	return [option.label, option.value].some(
		(value) => compactText(value).toLowerCase() === token
	);
}

function formatYesNoAction(options: YesNoOptions): string {
	return `Answer Yes / No… — Yes: ${formatOptionDetail(options.yes.option)}; No: ${formatOptionDetail(options.no.option)}`;
}

function formatYesNoMessage(options: YesNoOptions): string {
	return [
		`Yes: ${formatOptionDetail(options.yes.option)}`,
		`No: ${formatOptionDetail(options.no.option)}`,
	].join("\n");
}

function formatOptionDetail(option: AskQuestion["options"][number]): string {
	const description = option.description
		? ` — ${compactText(option.description)}`
		: "";
	const preview = option.preview
		? ` — Preview: ${compactText(option.preview)}`
		: "";
	return `${compactText(option.label)}${description}${preview}`;
}

function formatInputPlaceholder(currentText: string | undefined): string {
	return currentText?.trim()
		? `Current: ${truncateText(currentText)}. Enter a replacement or leave blank to clear.`
		: "Enter a short free-form answer";
}

function formatNotePlaceholder(currentNote: string | undefined): string {
	return currentNote?.trim()
		? `Current: ${truncateText(currentNote)}. Enter a replacement or leave blank to clear.`
		: "Add an optional note or comment";
}

function compactText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string): string {
	const compact = compactText(value);
	return compact.length > 80 ? `${compact.slice(0, 77)}…` : compact;
}
