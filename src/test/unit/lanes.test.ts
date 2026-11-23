import * as assert from 'node:assert/strict';
import { type LaneColor, type Segment, layoutLanes } from '../../lanes';

const show = (s: Segment) => (s.kind === 'through' ? `${s.from}>${s.to}` : s.kind === 'in' ? `in${s.from}` : `out${s.to}`);
const draw = (commits: [string, ...string[]][], colors: Record<string, LaneColor> = {}) =>
	layoutLanes(commits.map(([id, ...parents]) => ({ id, parents })), (id) => colors[id])
		.map((r) => `${r.circle}/${r.columns} ${r.segments.map(show).join(' ')}`.trim());

suite('lanes', () => {
	test('a line of commits stays in one lane, in the color of the branch it starts', () => {
		const rows = layoutLanes([{ id: 'c', parents: ['b'] }, { id: 'b', parents: ['a'] }, { id: 'a', parents: [] }], (id) => (id === 'c' ? 'ref' : undefined));
		assert.deepEqual(rows.map((r) => [r.circle, r.columns, r.color, r.below]), [[0, 1, 'ref', ['ref']], [0, 1, 'ref', ['ref']], [0, 1, 'ref', []]]);
		assert.deepEqual(rows.map((r) => r.segments.map(show)), [['out0'], ['in0', 'out0'], ['in0']]);
	});

	test('a stacked branch recolors the lane from its tip down', () => {
		const rows = layoutLanes([{ id: 'c', parents: ['b'] }, { id: 'b', parents: ['a'] }, { id: 'a', parents: [] }], (id) => ({ c: 'ref', b: 2, a: 'base' } as Record<string, LaneColor>)[id]);
		assert.deepEqual(rows.map((r) => r.color), ['ref', 2, 'base']);
		// the line into a commit is still its child's
		assert.deepEqual(rows[1].segments, [{ kind: 'in', from: 0, color: 'ref' }, { kind: 'out', to: 0, color: 2 }]);
	});

	test('two branches off one commit: the second gets a lane, and both end in the commit', () => {
		assert.deepEqual(draw([['x', 'a'], ['y', 'a'], ['a', 'root'], ['root']]), [
			'0/1 out0',
			'1/2 0>0 out1',
			'0/2 in0 out0 in1',
			'0/1 in0',
		]);
	});

	test('a lane that ends lets the ones to its right move left', () => {
		// x and y fork from different commits: x's lane ends at a, and y's moves into its place
		assert.deepEqual(draw([['x', 'a'], ['y', 'b'], ['a'], ['b']]), [
			'0/1 out0',
			'1/2 0>0 out1',
			'0/2 in0 1>0',
			'0/1 in0',
		]);
	});

	test('a merge opens a lane for its second parent; new lanes take the rotating colors in turn', () => {
		const rows = layoutLanes([{ id: 'm', parents: ['a', 'b'] }, { id: 'b', parents: ['a'] }, { id: 'a', parents: [] }], () => undefined);
		assert.deepEqual(rows.map((r) => `${r.circle}/${r.columns} ${r.segments.map(show).join(' ')}`), ['0/2 out0 out1', '1/2 0>0 in1 out1', '0/2 in0 in1']);
		assert.deepEqual(rows[0].below, [0, 1]);
	});

	test('a parent that never comes leaves its lane open', () => {
		assert.deepEqual(draw([['b', 'a'], ['c', 'gone']]), ['0/1 out0', '1/2 0>0 out1']);
	});
});
