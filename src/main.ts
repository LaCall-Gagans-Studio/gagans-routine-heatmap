import {
	ItemView,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	WorkspaceLeaf,
	setIcon,
	type EventRef,
	type ViewStateResult,
} from 'obsidian';

const VIEW_TYPE_ROUTINE_HEATMAP = 'gagans-routine-heatmap';

const HEAT_LEVELS = 5;
const WEEKDAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'];
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const TASK_LINE_REGEX = /^(\s*)- \[([^\]])\]\s+(.*)$/;
const DATE_NAME_REGEX = /^(\d{4})-?(\d{2})-?(\d{2})$/;
const ROUTINE_ID_REGEX = /^\{([^\s{}]+)\}/;

interface GagansRoutineHeatmapSettings {
	dailyNotesFolder: string;
	dailyTag: string;
	requireDailyTag: boolean;
	weekStartDay: number;
	showCurrentDayBorder: boolean;
	weekdayLanguage: 'en' | 'ja';
}

interface HeatEntry {
	count: number;
	path: string;
	ids: string[];
}

interface HeatmapEntry {
	date: string;
	intensity: number;
	path: string;
	title: string;
}

const DEFAULT_SETTINGS: GagansRoutineHeatmapSettings = {
	dailyNotesFolder: '',
	dailyTag: 'daily',
	requireDailyTag: false,
	weekStartDay: 0,
	showCurrentDayBorder: true,
	weekdayLanguage: 'en',
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function toIso(name: string): string | null {
	const match = String(name).match(DATE_NAME_REGEX);
	return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function extractRoutineId(text: string): string | null {
	const match = String(text).trim().match(ROUTINE_ID_REGEX);
	return match?.[1] ?? null;
}

function isTaskCompleted(marker: string): boolean {
	return marker === 'x' || marker === 'X';
}

function extractTasks(content: string): Array<{ marker: string; text: string; completed: boolean }> {
	const withoutFrontmatter = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
	const tasks: Array<{ marker: string; text: string; completed: boolean }> = [];
	for (const line of withoutFrontmatter.split(/\r?\n/)) {
		const match = line.match(TASK_LINE_REGEX);
		if (!match) continue;
		tasks.push({
			marker: match[2],
			text: match[3],
			completed: isTaskCompleted(match[2]),
		});
	}
	return tasks;
}

function collectRoutineIds(content: string): { discovered: Set<string>; completed: Set<string> } {
	const discovered = new Set<string>();
	const completed = new Set<string>();
	for (const task of extractTasks(content)) {
		const id = extractRoutineId(task.text);
		if (!id) continue;
		discovered.add(id);
		if (task.completed) completed.add(id);
	}
	return { discovered, completed };
}

function normalizeTag(value: string): string {
	return String(value || '').trim().replace(/^#/, '');
}

function tagsFromFrontmatter(value: unknown): string[] {
	if (!value) return [];
	if (Array.isArray(value)) return value.map((item) => normalizeTag(String(item)));
	if (typeof value === 'string') {
		return value
			.split(/[,\s]+/)
			.map(normalizeTag)
			.filter(Boolean);
	}
	return [];
}

function clamp(input: number, min: number, max: number): number {
	return input < min ? min : input > max ? max : input;
}

function mapRange(current: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
	if (inMax === inMin) return outMax;
	const mapped = ((current - inMin) * (outMax - outMin)) / (inMax - inMin) + outMin;
	return clamp(mapped, outMin, outMax);
}

function heatLevel(count: number, maxCount: number): number {
	if (!count) return 0;
	if (maxCount <= 1) return HEAT_LEVELS;
	return Math.round(mapRange(count, 1, maxCount, 1, HEAT_LEVELS));
}

function formatIso(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

function isSameDay(a: Date, b: Date): boolean {
	return (
		a.getFullYear() === b.getFullYear()
		&& a.getMonth() === b.getMonth()
		&& a.getDate() === b.getDate()
	);
}

function formatMonthLabel(date: Date, language: 'en' | 'ja'): string {
	return language === 'ja' ? `${date.getMonth() + 1}月` : MONTHS_EN[date.getMonth()];
}

function buildWeeks(year: number, weekStartDay: number, language: 'en' | 'ja') {
	const first = new Date(year, 0, 1);
	const startOffset = (first.getDay() - weekStartDay + 7) % 7;
	const cursor = new Date(year, 0, 1 - startOffset);
	const weeks: Array<{ days: Array<Date | null>; monthLabel: string }> = [];

	while (cursor.getFullYear() <= year) {
		const days: Array<Date | null> = [];
		let monthLabel = '';
		for (let i = 0; i < 7; i += 1) {
			const inYear = cursor.getFullYear() === year;
			const cellDate = inYear ? new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate()) : null;
			days.push(cellDate);
			if (cellDate && cellDate.getDate() === 1) {
				monthLabel = formatMonthLabel(cellDate, language);
			}
			cursor.setDate(cursor.getDate() + 1);
		}
		if (days.every((day) => !day)) break;
		weeks.push({ days, monthLabel });
		if (cursor.getFullYear() > year) break;
	}

	return weeks;
}

function formatHeatTitle(iso: string, ids: string[]): string {
	const idLabel = ids.map((id) => `{${id}}`).join(' ');
	return idLabel ? `${iso} · ${ids.length} done ${idLabel}` : `${iso} · ${ids.length} done`;
}

class RoutineHeatmapView extends ItemView {
	plugin: GagansRoutineHeatmapPlugin;
	year: number;
	refreshTimer: number | null;
	isOpen: boolean;
	resizeObserver: ResizeObserver | null;

	constructor(leaf: WorkspaceLeaf, plugin: GagansRoutineHeatmapPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.year = new Date().getFullYear();
		this.refreshTimer = null;
		this.isOpen = false;
		this.resizeObserver = null;
	}

	getViewType(): string {
		return VIEW_TYPE_ROUTINE_HEATMAP;
	}

	getDisplayText(): string {
		return 'Routine Heatmap';
	}

	getIcon(): string {
		return 'calendar-check';
	}

	getState(): { year: number } {
		return { year: this.year };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		if (state && typeof state === 'object' && 'year' in state) {
			const year = (state as { year?: unknown }).year;
			if (typeof year === 'number' && Number.isFinite(year)) {
				this.year = year;
			}
		}
		await super.setState(state, result);
		if (this.isOpen) await this.render();
	}

	async onOpen(): Promise<void> {
		this.isOpen = true;
		this.contentEl.addClass('routine-heatmap-view');
		this.registerEvent(this.app.vault.on('create', (file) => this.onVaultFileChange(file)));
		this.registerEvent(this.app.vault.on('modify', (file) => this.onVaultFileChange(file)));
		this.registerEvent(this.app.vault.on('delete', (file) => this.onVaultFileChange(file)));
		this.registerEvent(this.app.vault.on('rename', (file) => this.onVaultFileChange(file)));
		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => this.onVaultFileChange(file)),
		);
		this.resizeObserver = new ResizeObserver(() => this.syncCellSize());
		this.resizeObserver.observe(this.contentEl);
		this.register(() => {
			this.resizeObserver?.disconnect();
			this.resizeObserver = null;
		});
		await this.render();
	}

	async onClose(): Promise<void> {
		this.isOpen = false;
		this.clearRefreshTimer();
	}

	syncCellSize(): void {
		const grid = this.contentEl.querySelector('.routine-heatmap-grid');
		if (!(grid instanceof HTMLElement)) return;
		const sample = grid.querySelector('.routine-heatmap-cell');
		if (!sample) return;
		const size = Math.floor(sample.getBoundingClientRect().width);
		if (size > 0) {
			grid.style.setProperty('--cell-size', `${size}px`);
		}
	}

	onVaultFileChange(file: unknown): void {
		if (file instanceof TFile && !this.plugin.isDailyNoteFile(file)) return;
		this.queueRender();
	}

	queueRender(): void {
		this.clearRefreshTimer();
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			void this.render();
		}, 400);
	}

	clearRefreshTimer(): void {
		if (this.refreshTimer != null) {
			window.clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
	}

	async render(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('routine-heatmap-view');

		const toolbar = contentEl.createDiv({ cls: 'routine-heatmap-toolbar' });
		const yearNav = toolbar.createDiv({ cls: 'routine-heatmap-year-nav' });

		const prevButton = yearNav.createEl('button', {
			cls: 'clickable-icon',
			attr: { 'aria-label': 'Previous year' },
		});
		setIcon(prevButton, 'chevron-left');
		prevButton.addEventListener('click', () => {
			this.year -= 1;
			void this.render();
		});

		yearNav.createDiv({ cls: 'routine-heatmap-year-label', text: String(this.year) });

		const nextButton = yearNav.createEl('button', {
			cls: 'clickable-icon',
			attr: { 'aria-label': 'Next year' },
		});
		setIcon(nextButton, 'chevron-right');
		nextButton.addEventListener('click', () => {
			this.year += 1;
			void this.render();
		});

		const refreshButton = toolbar.createEl('button', {
			cls: 'clickable-icon',
			attr: { 'aria-label': 'Reload' },
		});
		setIcon(refreshButton, 'refresh-cw');
		refreshButton.addEventListener('click', () => void this.render());

		const snapshot = await this.plugin.buildYearSnapshot(this.year);
		this.plugin.renderHeatmap(contentEl, {
			year: this.year,
			showCurrentDayBorder: this.plugin.settings.showCurrentDayBorder,
			entries: snapshot.overall,
			onSelect: (path) => {
				void this.plugin.openDailyNote(path);
			},
		});
		this.syncCellSize();
		window.requestAnimationFrame(() => this.syncCellSize());
	}
}

class GagansRoutineHeatmapSettingTab extends PluginSettingTab {
	plugin: GagansRoutineHeatmapPlugin;

	constructor(app: GagansRoutineHeatmapPlugin['app'], plugin: GagansRoutineHeatmapPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Daily notes folder')
			.setDesc('Vault-relative folder of daily notes. Leave empty to scan the whole vault.')
			.addText((text) =>
				text
					.setPlaceholder('Daily')
					.setValue(this.plugin.settings.dailyNotesFolder)
					.onChange(async (value) => {
						this.plugin.settings.dailyNotesFolder = value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
						await this.plugin.saveSettings();
						await this.plugin.refreshAll();
					}),
			);

		new Setting(containerEl)
			.setName('Require daily tag')
			.setDesc('Only include notes that have the daily tag in frontmatter or in the file.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.requireDailyTag).onChange(async (value) => {
					this.plugin.settings.requireDailyTag = value;
					await this.plugin.saveSettings();
					await this.plugin.refreshAll();
				}),
			);

		new Setting(containerEl)
			.setName('Daily tag')
			.setDesc('Tag used to identify daily notes, without #.')
			.addText((text) =>
				text
					.setPlaceholder('daily')
					.setValue(this.plugin.settings.dailyTag)
					.onChange(async (value) => {
						this.plugin.settings.dailyTag = value.trim().replace(/^#/, '') || DEFAULT_SETTINGS.dailyTag;
						await this.plugin.saveSettings();
						await this.plugin.refreshAll();
					}),
			);

		new Setting(containerEl)
			.setName('Week start day')
			.setDesc('First column of each heatmap.')
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						0: 'Sunday',
						1: 'Monday',
						2: 'Tuesday',
						3: 'Wednesday',
						4: 'Thursday',
						5: 'Friday',
						6: 'Saturday',
					})
					.setValue(String(this.plugin.settings.weekStartDay))
					.onChange(async (value) => {
						this.plugin.settings.weekStartDay = Number(value);
						await this.plugin.saveSettings();
						await this.plugin.refreshAll();
					}),
			);

		new Setting(containerEl)
			.setName('Weekday language')
			.setDesc('Labels on the heatmap weekday row.')
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						en: 'English',
						ja: 'Japanese',
					})
					.setValue(this.plugin.settings.weekdayLanguage)
					.onChange(async (value) => {
						this.plugin.settings.weekdayLanguage = value === 'ja' ? 'ja' : 'en';
						await this.plugin.saveSettings();
						await this.plugin.refreshAll();
					}),
			);

		new Setting(containerEl)
			.setName('Highlight today')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showCurrentDayBorder).onChange(async (value) => {
					this.plugin.settings.showCurrentDayBorder = value;
					await this.plugin.saveSettings();
					await this.plugin.refreshAll();
				}),
			);
	}
}

export default class GagansRoutineHeatmapPlugin extends Plugin {
	settings: GagansRoutineHeatmapSettings = { ...DEFAULT_SETTINGS };
	heatByDate = new Map<string, HeatEntry>();
	maxRoutineCount = 1;
	rebuildTimer: number | null = null;
	calendarSource = this.createCalendarSource();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.calendarSource = this.createCalendarSource();

		this.registerEvent(
			(this.app.workspace as unknown as { on: (name: string, cb: (sources: unknown) => void) => EventRef }).on(
				'calendar:open',
				(sources: unknown) => {
					if (Array.isArray(sources)) sources.push(this.calendarSource);
				},
			),
		);

		this.registerView(
			VIEW_TYPE_ROUTINE_HEATMAP,
			(leaf) => new RoutineHeatmapView(leaf, this),
		);
		this.addRibbonIcon('calendar-check', 'Open routine heatmap', () => {
			void this.activateView();
		});
		this.addCommand({
			id: 'open-routine-heatmap',
			name: 'Open view',
			callback: () => {
				void this.activateView();
			},
		});
		this.addSettingTab(new GagansRoutineHeatmapSettingTab(this.app, this));

		this.registerEvent(this.app.vault.on('create', (file) => this.queueRebuild(file)));
		this.registerEvent(this.app.vault.on('modify', (file) => this.queueRebuild(file)));
		this.registerEvent(this.app.vault.on('delete', (file) => this.queueRebuild(file)));
		this.registerEvent(this.app.vault.on('rename', () => this.queueRebuild()));

		await this.rebuildHeatIndex();
		this.app.workspace.onLayoutReady(() => {
			this.reattachCalendarSources();
		});
	}

	onunload(): void {
		if (this.rebuildTimer != null) window.clearTimeout(this.rebuildTimer);
		this.app.workspace.getLeavesOfType(VIEW_TYPE_ROUTINE_HEATMAP).forEach((leaf) => leaf.detach());
	}

	async loadSettings(): Promise<void> {
		this.settings = { ...DEFAULT_SETTINGS, ...this.parseSettings(await this.loadData()) };
		if (this.settings.weekdayLanguage !== 'ja') this.settings.weekdayLanguage = 'en';
	}

	parseSettings(raw: unknown): Partial<GagansRoutineHeatmapSettings> {
		if (!isRecord(raw)) return {};
		const parsed: Partial<GagansRoutineHeatmapSettings> = {};
		if (typeof raw.dailyNotesFolder === 'string') parsed.dailyNotesFolder = raw.dailyNotesFolder;
		if (typeof raw.dailyTag === 'string') parsed.dailyTag = raw.dailyTag;
		if (typeof raw.requireDailyTag === 'boolean') parsed.requireDailyTag = raw.requireDailyTag;
		if (typeof raw.weekStartDay === 'number') parsed.weekStartDay = raw.weekStartDay;
		if (typeof raw.showCurrentDayBorder === 'boolean') parsed.showCurrentDayBorder = raw.showCurrentDayBorder;
		if (raw.weekdayLanguage === 'en' || raw.weekdayLanguage === 'ja') {
			parsed.weekdayLanguage = raw.weekdayLanguage;
		}
		return parsed;
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	createCalendarSource() {
		return {
			getDailyMetadata: async (date: { format?: (fmt: string) => string; toDate?: () => Date }) =>
				this.getCalendarDayMetadata(date),
			getWeeklyMetadata: async () => ({ classes: [], dots: [] }),
		};
	}

	getCalendarDayMetadata(date: { format?: (fmt: string) => string; toDate?: () => Date } | Date) {
		const iso =
			typeof (date as { format?: (fmt: string) => string }).format === 'function'
				? (date as { format: (fmt: string) => string }).format('YYYY-MM-DD')
				: formatIso(
					typeof (date as { toDate?: () => Date }).toDate === 'function'
						? (date as { toDate: () => Date }).toDate()
						: (date as Date),
				);
		const entry = this.heatByDate.get(iso);
		if (!entry) return { classes: [], dataAttributes: {}, dots: [] };
		const level = heatLevel(entry.count, this.maxRoutineCount);
		return {
			classes: ['routine-heat', `routine-heat-${level}`],
			dataAttributes: {
				'data-routine-heat': String(level),
			},
			dots: [],
		};
	}

	queueRebuild(file?: unknown): void {
		if (file instanceof TFile && !this.isDailyNoteFile(file)) return;
		if (this.rebuildTimer != null) window.clearTimeout(this.rebuildTimer);
		this.rebuildTimer = window.setTimeout(() => {
			this.rebuildTimer = null;
			void this.refreshAll();
		}, 400);
	}

	async refreshAll(): Promise<void> {
		await this.rebuildHeatIndex();
		this.refreshCalendar();
		this.refreshOpenViews();
	}

	refreshOpenViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_ROUTINE_HEATMAP)) {
			if (leaf.view instanceof RoutineHeatmapView) {
				void leaf.view.render();
			}
		}
	}

	refreshCalendar(): void {
		for (const leaf of this.app.workspace.getLeavesOfType('calendar')) {
			const calendar = (leaf.view as { calendar?: { tick?: () => void } }).calendar;
			if (calendar && typeof calendar.tick === 'function') {
				calendar.tick();
			}
		}
	}

	reattachCalendarSources(): void {
		for (const leaf of this.app.workspace.getLeavesOfType('calendar')) {
			const view = leaf.view as unknown as { onOpen?: () => unknown; calendar?: { $destroy?: () => void } | null };
			if (!view || typeof view.onOpen !== 'function') continue;
			if (view.calendar && typeof view.calendar.$destroy === 'function') {
				view.calendar.$destroy();
				view.calendar = null;
			}
			void view.onOpen();
		}
	}

	async rebuildHeatIndex(): Promise<void> {
		const heatByDate = new Map<string, HeatEntry>();
		const discovered = new Set<string>();
		const files = this.app.vault.getMarkdownFiles().filter((file) => this.isDailyNoteFile(file));
		for (const file of files) {
			if (this.settings.requireDailyTag && !this.fileHasDailyTag(file)) continue;
			const iso = toIso(file.basename);
			if (!iso) continue;
			const content = await this.app.vault.cachedRead(file);
			const stats = collectRoutineIds(content);
			for (const id of stats.discovered) discovered.add(id);
			if (stats.completed.size === 0) continue;
			heatByDate.set(iso, {
				count: stats.completed.size,
				path: file.path,
				ids: [...stats.completed],
			});
		}
		this.maxRoutineCount = Math.max(1, discovered.size);
		this.heatByDate = heatByDate;
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_ROUTINE_HEATMAP);
		if (existing.length) {
			workspace.setActiveLeaf(existing[0], { focus: true });
			return;
		}

		let leaf: WorkspaceLeaf | null = null;
		const calendarLeaves = workspace.getLeavesOfType('calendar');
		if (calendarLeaves.length && typeof workspace.createLeafInParent === 'function') {
			const parent = calendarLeaves[0].parent as { children?: unknown[] } | null;
			if (parent) {
				leaf = workspace.createLeafInParent(parent as never, parent.children?.length ?? 0);
			}
		}
		if (!leaf) {
			leaf = workspace.getLeaf('tab');
		}
		await leaf.setViewState({
			type: VIEW_TYPE_ROUTINE_HEATMAP,
			active: true,
		});
		workspace.setActiveLeaf(leaf, { focus: true });
	}

	normalizeFolder(folder: string): string {
		return (folder || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
	}

	isDailyNoteFile(file: TFile): boolean {
		if (!(file instanceof TFile) || file.extension !== 'md') return false;
		if (!toIso(file.basename)) return false;
		const folder = this.normalizeFolder(this.settings.dailyNotesFolder);
		const path = file.path.replace(/\\/g, '/');
		return folder ? path.startsWith(`${folder}/`) : true;
	}

	fileHasDailyTag(file: TFile): boolean {
		const needle = normalizeTag(this.settings.dailyTag);
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache) return false;

		const collected = [
			...tagsFromFrontmatter(cache.frontmatter?.tags),
			...tagsFromFrontmatter(cache.frontmatter?.tag),
		];
		for (const entry of cache.tags || []) {
			collected.push(normalizeTag(entry.tag));
		}
		return collected.includes(needle);
	}

	async buildYearSnapshot(year: number): Promise<{ overall: HeatmapEntry[] }> {
		const overall: HeatmapEntry[] = [];
		const yearPrefix = String(year);
		const files = this.app.vault
			.getMarkdownFiles()
			.filter((file) => this.isDailyNoteFile(file) && file.basename.startsWith(yearPrefix))
			.sort((a, b) => a.basename.localeCompare(b.basename));

		for (const file of files) {
			if (this.settings.requireDailyTag && !this.fileHasDailyTag(file)) continue;
			const iso = toIso(file.basename);
			if (!iso) continue;

			const content = await this.app.vault.cachedRead(file);
			const stats = collectRoutineIds(content);
			if (stats.completed.size === 0) continue;

			const ids = [...stats.completed];
			overall.push({
				date: iso,
				intensity: stats.completed.size,
				path: file.path,
				title: formatHeatTitle(iso, ids),
			});
		}

		return { overall };
	}

	renderHeatmap(
		parent: HTMLElement,
		calendarData: {
			year: number;
			showCurrentDayBorder?: boolean;
			entries: HeatmapEntry[];
			onSelect?: (path: string) => void;
		},
	): void {
		const year = calendarData.year;
		const showCurrentDayBorder =
			calendarData.showCurrentDayBorder ?? this.settings.showCurrentDayBorder;
		const weekStartDay = this.settings.weekStartDay;
		const weekdays = this.settings.weekdayLanguage === 'ja' ? WEEKDAYS_JA : WEEKDAYS_EN;
		const today = new Date();
		const entriesByDate = new Map(
			(calendarData.entries || []).map((entry) => [entry.date, entry]),
		);

		const grid = parent.createDiv({ cls: 'routine-heatmap-grid' });
		grid.createDiv({ cls: 'routine-heatmap-month' });
		for (let i = 0; i < 7; i += 1) {
			grid.createDiv({
				cls: 'routine-heatmap-weekday',
				text: weekdays[(i + weekStartDay) % 7],
			});
		}

		for (const week of buildWeeks(year, weekStartDay, this.settings.weekdayLanguage)) {
			grid.createDiv({ cls: 'routine-heatmap-month', text: week.monthLabel });
			for (const day of week.days) {
				if (!day) {
					grid.createDiv({ cls: 'routine-heatmap-cell isSpacer' });
					continue;
				}

				const iso = formatIso(day);
				const entry = entriesByDate.get(iso);
				const classNames = ['routine-heatmap-cell'];
				const attr: Record<string, string> = { 'data-date': iso };
				if (showCurrentDayBorder && isSameDay(day, today)) {
					classNames.push('today');
				}
				if (entry) {
					classNames.push('hasData');
					attr.title = entry.title;
					attr['data-heat'] = String(heatLevel(entry.intensity, this.maxRoutineCount));
				} else {
					classNames.push('isEmpty');
					attr.title = iso;
				}

				const cell = grid.createDiv({ cls: classNames.join(' '), attr });
				if (entry && typeof calendarData.onSelect === 'function') {
					cell.addEventListener('click', (event) => {
						event.preventDefault();
						calendarData.onSelect?.(entry.path);
					});
				}
			}
		}
	}

	async openDailyNote(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		const { workspace } = this.app;
		const leaf =
			(typeof workspace.getMostRecentLeaf === 'function'
				? workspace.getMostRecentLeaf(workspace.rootSplit)
				: null)
			|| workspace.getLeaf('tab');
		await leaf.openFile(file);
		workspace.setActiveLeaf(leaf, { focus: true });
	}
}
