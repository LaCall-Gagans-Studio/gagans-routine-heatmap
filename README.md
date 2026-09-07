# Routine Heatmap (Gagans)

Show a yearly heatmap (and optional [Calendar](https://github.com/liamcain/obsidian-calendar-plugin) day colors) from completed routine tasks in daily notes.

Routines are detected only by a leading `{id}` token on a task, for example:

```markdown
- [x] {wk} Wake up on time
- [ ] {wo} Workout
```

The plugin does not ship a built-in list of routines. Any `{id}` that appears in your daily notes is counted. Completing more unique ids on a day makes that cell hotter.

Daily note filenames can be `YYYYMMDD` or `YYYY-MM-DD`.

## Settings

- **Daily notes folder**: vault-relative folder, or empty to scan the whole vault
- **Require daily tag** / **Daily tag**: optional frontmatter or inline tag filter
- **Week start day** and **Weekday language**
- **Highlight today**

## Install from GitHub

1. Download `main.js`, `manifest.json`, and `styles.css` from a [release](https://github.com/LaCall-Gagans-Studio/gagans-routine-heatmap/releases)
2. Copy them into `<vault>/.obsidian/plugins/gagans-routine-heatmap/`
3. Enable the plugin in Settings → Community plugins

## Build

```bash
npm install
npm run build
```
