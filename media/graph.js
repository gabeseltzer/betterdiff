// The Commits view's webview: draws the rows src/views/graph.ts lays out, in the manner of VS
// Code's Source Control Graph. A commit opens to the files it changed; a file opens its diff.
(function () {
	const vscode = acquireVsCodeApi();
	const NS = 'http://www.w3.org/2000/svg';
	// a lane's width, a row's height, the radius of a lane changing column
	const W = 11, H = 22, R = 5;
	const MID = H / 2;

	const list = document.getElementById('list');
	/** the commits that are open, by row id (kept while the view is hidden) */
	const expanded = new Set((vscode.getState() ?? {}).expanded ?? []);
	/** row id -> the files it changed, once asked for */
	const files = new Map();
	let rows = [];
	let messages = [];
	let selected;
	/** a row to scroll to once it's drawn */
	let reveal;

	const x = (column) => W * (column + 1);
	const save = () => vscode.setState({ expanded: [...expanded] });

	function el(tag, className, text) {
		const e = document.createElement(tag);
		e.className = className;
		if (text !== undefined) {
			e.textContent = text;
		}
		return e;
	}

	function shape(tag, className, attributes) {
		const s = document.createElementNS(NS, tag);
		s.setAttribute('class', className);
		for (const [name, value] of Object.entries(attributes)) {
			s.setAttribute(name, String(value));
		}
		return s;
	}

	const line = (d, color) => shape('path', `lane c-${color}`, { d });

	function canvas(columns) {
		const width = W * (columns + 1);
		return shape('svg', 'graph', { width, height: H, viewBox: `0 0 ${width} ${H}` });
	}

	/** A commit's row of the graph: the lanes passing by, those ending in it, and its circle. */
	function graphOf(row) {
		const { lanes } = row;
		const svg = canvas(lanes.columns);
		const at = x(lanes.circle);
		for (const s of lanes.segments) {
			if (s.kind === 'through') {
				svg.append(line(s.from === s.to
					? `M ${x(s.from)} 0 V ${H}`
					: `M ${x(s.from)} 0 V ${MID - R} A ${R} ${R} 0 0 1 ${x(s.from) - R} ${MID} H ${x(s.to) + R} A ${R} ${R} 0 0 0 ${x(s.to)} ${MID + R} V ${H}`, s.color));
			} else if (s.kind === 'in') {
				svg.append(line(s.from === lanes.circle
					? `M ${at} 0 V ${MID}`
					: `M ${x(s.from)} 0 A ${W} ${W} 0 0 1 ${x(s.from) - W} ${MID} H ${at}`, s.color));
			} else {
				svg.append(line(s.to === lanes.circle
					? `M ${at} ${MID} V ${H}`
					: `M ${at} ${MID} H ${x(s.to) - W} A ${W} ${W} 0 0 1 ${x(s.to)} ${H}`, s.color));
			}
		}
		const color = `c-${lanes.color}`;
		if (row.kind === 'uncommitted') {
			svg.append(shape('circle', `dot hollow ${color}`, { cx: at, cy: MID, r: 4 }));
		} else if (row.head) {
			svg.append(shape('circle', `dot ${color}`, { cx: at, cy: MID, r: 5 }), shape('circle', 'hole', { cx: at, cy: MID, r: 2 }));
		} else if (row.merge) {
			svg.append(shape('circle', `dot ${color}`, { cx: at, cy: MID, r: 5 }), shape('circle', 'hole', { cx: at, cy: MID, r: 3 }));
		} else {
			svg.append(shape('circle', `dot ${color}`, { cx: at, cy: MID, r: 4 }));
		}
		return svg;
	}

	/** Under an open commit: the lanes that go on below it. */
	function lanesBelow(row) {
		const { below } = row.lanes;
		const svg = canvas(Math.max(below.length, row.lanes.circle + 1));
		below.forEach((color, column) => svg.append(line(`M ${x(column)} 0 V ${H}`, color)));
		return svg;
	}

	function commitRow(row) {
		const div = el('div', `row ${row.kind}`);
		div.dataset.id = row.id;
		div.tabIndex = -1;
		div.title = row.tooltip;
		div.setAttribute('role', 'treeitem');
		if (row.kind !== 'boundary') {
			div.setAttribute('aria-expanded', String(expanded.has(row.id)));
		}
		if (row.sha) {
			div.dataset.vscodeContext = JSON.stringify({ webviewSection: 'commit', betterdiffSha: true, sha: row.sha });
		}
		div.append(graphOf(row), el('span', 'subject', row.subject), el('span', 'desc', row.description ?? ''));
		if (row.badges.length) {
			const badges = el('span', 'badges');
			for (const b of row.badges) {
				const badge = el('span', `badge c-${b.color}${b.current ? ' current' : ''}`, b.prNumber ? `${b.label} #${b.prNumber}` : b.label);
				badge.title = b.current ? `${b.label} (checked out)` : b.label;
				if (b.branch) {
					badge.dataset.vscodeContext = JSON.stringify({
						webviewSection: 'ref', branch: b.branch, prUrl: b.prUrl,
						betterdiffRef: b.current ? 'current' : 'other', betterdiffPr: Boolean(b.prUrl),
					});
				}
				badges.append(badge);
			}
			div.append(badges);
		}
		return div;
	}

	function fileRow(row, file) {
		const div = el('div', 'row file');
		div.dataset.id = file.id;
		div.dataset.owner = row.id;
		div.tabIndex = -1;
		div.title = file.tooltip;
		div.setAttribute('role', 'treeitem');
		div.append(lanesBelow(row), el('span', 'name', file.name), el('span', 'desc', file.description), el('span', `status s-${file.status}`, file.letter));
		return div;
	}

	function messageRow(message) {
		const div = el('div', `row message${message.command ? ' link' : ''}`);
		div.tabIndex = -1;
		if (message.command) {
			div.dataset.command = message.command;
		}
		div.append(el('span', 'subject', message.label), el('span', 'desc', message.description ?? ''));
		return div;
	}

	function render() {
		const focused = list.contains(document.activeElement) ? document.activeElement.dataset?.id : undefined;
		const nodes = messages.map(messageRow);
		let fileCount = 0;
		for (const row of rows) {
			nodes.push(commitRow(row));
			if (expanded.has(row.id)) {
				for (const file of files.get(row.id) ?? []) {
					nodes.push(fileRow(row, file));
					fileCount++;
				}
			}
		}
		for (const node of nodes) {
			node.classList.toggle('selected', node.dataset.id !== undefined && node.dataset.id === selected);
		}
		list.replaceChildren(...nodes);
		if (focused !== undefined) {
			(rowOf(focused) ?? list).focus();
		}
		const target = reveal && rowOf(reveal);
		if (target) {
			target.scrollIntoView({ block: 'nearest' });
			reveal = undefined;
		}
		vscode.postMessage({ type: 'rendered', rows: rows.length, files: fileCount });
	}

	const rowOf = (id) => [...list.children].find((n) => n.dataset.id === id);

	function askFiles(id) {
		vscode.postMessage({ type: 'files', id });
	}

	function toggle(id, open = !expanded.has(id)) {
		if (open) {
			expanded.add(id);
			if (!files.has(id)) {
				askFiles(id);
			}
		} else {
			expanded.delete(id);
		}
		save();
		render();
	}

	function activate(node) {
		if (node.dataset.command) {
			vscode.postMessage({ type: 'command', command: node.dataset.command });
			return;
		}
		const { id } = node.dataset;
		if (id === undefined) {
			return;
		}
		selected = id;
		if (node.classList.contains('file')) {
			render();
			vscode.postMessage({ type: 'open', id });
		} else if (node.classList.contains('boundary')) {
			render();
		} else {
			toggle(id);
		}
		rowOf(id)?.focus();
	}

	list.addEventListener('click', (e) => {
		const node = e.target.closest?.('.row');
		if (node) {
			activate(node);
		}
	});

	list.addEventListener('keydown', (e) => {
		const all = [...list.children];
		const node = document.activeElement?.closest?.('.row');
		const at = all.indexOf(node);
		const go = (to) => {
			if (to) {
				to.focus();
				to.scrollIntoView({ block: 'nearest' });
			}
		};
		switch (e.key) {
			case 'ArrowDown':
				go(all[at + 1]);
				break;
			case 'ArrowUp':
				go(at === -1 ? all[all.length - 1] : all[at - 1]);
				break;
			case 'Enter':
			case ' ':
				if (node) {
					activate(node);
				}
				break;
			case 'ArrowRight':
				if (node?.hasAttribute('aria-expanded') && !expanded.has(node.dataset.id)) {
					toggle(node.dataset.id, true);
					rowOf(node.dataset.id)?.focus();
				}
				break;
			case 'ArrowLeft':
				if (node?.classList.contains('file')) {
					go(rowOf(node.dataset.owner));
				} else if (node && expanded.has(node.dataset.id)) {
					toggle(node.dataset.id, false);
					rowOf(node.dataset.id)?.focus();
				}
				break;
			default:
				return;
		}
		e.preventDefault();
	});

	window.addEventListener('message', ({ data }) => {
		switch (data.type) {
			case 'model': {
				rows = data.rows;
				messages = data.messages;
				const ids = new Set(rows.map((r) => r.id));
				for (const id of [...expanded]) {
					if (!ids.has(id)) {
						expanded.delete(id);
					}
				}
				for (const id of [...files.keys()]) {
					if (!ids.has(id)) {
						files.delete(id);
					}
				}
				// a commit's files never change; what's uncommitted does
				for (const id of expanded) {
					if (!files.has(id) || rows.find((r) => r.id === id)?.kind === 'uncommitted') {
						askFiles(id);
					}
				}
				save();
				render();
				break;
			}
			case 'files':
				files.set(data.id, data.files);
				render();
				break;
			case 'select':
				selected = data.id;
				reveal = data.id;
				if (!expanded.has(data.owner)) {
					expanded.add(data.owner);
					save();
				}
				if (!files.has(data.owner)) {
					askFiles(data.owner);
				}
				render();
				break;
		}
	});

	vscode.postMessage({ type: 'ready' });
})();
