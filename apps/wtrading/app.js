/*
 * WTrading — chart + formulas of the difference-quotient theory.
 * Uses lightweight-charts v5 (standalone build, window.LightweightCharts).
 * Market data: Kraken public REST API (no authentication required).
 */
(function() {
	'use strict';

	// ---- data source configuration ----
	const CONFIG = {
		pair: 'USDCEUR',
		interval: 1440, // minutes per bar: 1440 = 1D
		displayName: 'USDC / EUR',
		intervalLabel: '1D',
		maPeriod: 9,
		pollMs: 60000, // live poll interval in ms
	};

	const COLORS = {
		green: '#3ddc84',
		greenSoft: '#26a69a',
		orange: '#ff9800',
		blue: '#4cc2ff',
		blueAccent: '#0078d4',
		red: '#ef5350',
		text: 'rgba(255,255,255,0.7)',
		grid: 'rgba(255,255,255,0.06)',
	};

	const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618];
	const DIFF_LEVEL = 1;

	// ---- Kraken public REST: fetch OHLC bars ----
	const mapKrakenRow = r => ({ time: r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4] });

	async function fetchKrakenOHLC(pair, interval) {
		const url = 'https://api.kraken.com/0/public/OHLC?pair=' + pair + '&interval=' + interval;
		let resp;
		try {
			resp = await fetch(url);
		} catch (err) {
			throw new Error('Netzwerkfehler: ' + err.message);
		}
		if (!resp.ok) { throw new Error('HTTP ' + resp.status); }
		const json = await resp.json();
		if (json.error && json.error.length) { throw new Error(json.error[0]); }
		// result contains the pair data array and a "last" timestamp key
		const rows = Object.values(json.result).find(v => Array.isArray(v));
		if (!rows || rows.length < 2) { throw new Error('Keine Daten f\u00fcr ' + pair); }
		// Kraken includes the current incomplete bar as the last row — keep it for live display
		return rows.map(mapKrakenRow);
	}

	// ---- math: moving average + quotients ----
	function movingAverage(candles, period) {
		const out = [];
		let sum = 0;
		for (let i = 0; i < candles.length; i++) {
			sum += candles[i].close;
			if (i >= period) { sum -= candles[i - period].close; }
			if (i >= period - 1) {
				out.push({ time: candles[i].time, value: sum / period });
			}
		}
		return out;
	}

	// difference quotient between two points (slope normalized per bar, scaled)
	function differenceQuotient(p0, p1, barsBetween, scale) {
		if (!barsBetween) { return 0; }
		return ((p1 - p0) / barsBetween) * scale;
	}

	// numerical differential quotient series of a line (per bar, scaled)
	function differential(line, scale) {
		const out = [];
		for (let i = 1; i < line.length; i++) {
			out.push({ time: line[i].time, value: (line[i].value - line[i - 1].value) * scale });
		}
		return out;
	}

	// average differential over a slice
	function avgDifferential(diff, from, to) {
		const slice = diff.slice(Math.max(0, from), Math.max(0, to));
		if (!slice.length) { return 0; }
		return slice.reduce((a, p) => a + p.value, 0) / slice.length;
	}

	// auto-scale: map average absolute bar change to 0.5 so threshold math is data-independent
	function computeScale(ma) {
		let sum = 0;
		for (let i = 1; i < ma.length; i++) {
			sum += Math.abs(ma[i].value - ma[i - 1].value);
		}
		const avg = sum / (ma.length - 1) || 1e-9;
		return 0.5 / avg;
	}

	// theory threshold: differential quotients staying above/below this value
	// signal continuation to the next fibonacci level
	const THRESHOLD = 0.5;

	const clampIndex = (i, max) => Math.max(0, Math.min(i, max));

	const fmtDiff = value => (value >= 0 ? '+' : '') + value.toFixed(3);

	function findThresholdCrossings(diff, level) {
		const out = [];
		for (let i = 1; i < diff.length; i++) {
			const prev = diff[i - 1].value;
			const curr = diff[i].value;
			if (prev <= level && curr >= level) {
				out.push({ index: i, type: 'low' });
			} else if (prev >= level && curr <= level) {
				out.push({ index: i, type: 'high' });
			}
		}
		return out;
	}

	function findNearestToValue(diff, start, end, target) {
		const from = clampIndex(start, diff.length - 1);
		const to = clampIndex(end, diff.length - 1);
		let idx = from;
		let best = Infinity;
		for (let i = from; i <= to; i++) {
			const distance = Math.abs(diff[i].value - target);
			if (distance < best) {
				best = distance;
				idx = i;
			}
		}
		return idx;
	}

	function findT1(diff, t0, t2, phase) {
		const start = clampIndex(t0 + 1, diff.length - 1);
		const end = clampIndex(Math.max(start, t2 - 1), diff.length - 1);
		let idx = start;
		let best = phase === 'low' ? -Infinity : Infinity;
		for (let i = start; i <= end; i++) {
			const value = diff[i].value;
			if ((phase === 'low' && value > best) || (phase === 'high' && value < best)) {
				best = value;
				idx = i;
			}
		}
		return idx;
	}

	function findT4(diff, start, phase) {
		const from = clampIndex(start, diff.length - 1);
		for (let i = Math.max(1, from); i < diff.length; i++) {
			const prev = diff[i - 1].value;
			const curr = diff[i].value;
			if ((phase === 'low' && prev <= 0 && curr >= 0) || (phase === 'high' && prev >= 0 && curr <= 0)) {
				return i;
			}
		}
		return findNearestToValue(diff, from, diff.length - 1, 0);
	}

	function resolveCycle(diff) {
		const maxDiffIdx = Math.max(0, diff.length - 1);
		const crossings = findThresholdCrossings(diff, DIFF_LEVEL);
		let t0Pos = crossings.length > 1 ? crossings.length - 2 : crossings.length - 1;
		if (t0Pos < 0) { t0Pos = 0; }
		const t0Cross = crossings[t0Pos];
		const t0 = t0Cross ? t0Cross.index : findNearestToValue(diff, 1, maxDiffIdx, DIFF_LEVEL);

		let t2 = -1;
		for (let i = t0Pos + 1; i < crossings.length; i++) {
			t2 = crossings[i].index;
			break;
		}
		if (t2 === -1) {
			t2 = findNearestToValue(diff, t0 + 1, maxDiffIdx, DIFF_LEVEL);
		}
		if (t2 <= t0) {
			t2 = clampIndex(t0 + 1, maxDiffIdx);
		}

		const phase = t0Cross ? t0Cross.type : (diff[t0].value >= DIFF_LEVEL ? 'low' : 'high');
		const t1 = findT1(diff, t0, t2, phase);
		const t3 = findNearestToValue(diff, t2 + 1, maxDiffIdx, phase === 'low' ? -1 : 1);
		const t4 = findT4(diff, t3 + 1, phase);
		return { t0, t1, t2, t3, t4, phase, maxDiffIdx };
	}

	// ---- theory: threshold-based cycle snapping (t0/t2/t3/t4) ----
	function analyze(candles, ma) {
		// Scale normalizes bar-to-bar slopes so that an average move maps to 0.5
		// and the "f' \u2265 1" breakout condition is ~2\u00d7 the average daily move.
		const scale = computeScale(ma);
		const diff = differential(ma, scale);
		const maOffset = candles.length - ma.length;
		if (!diff.length) {
			const c = candles[candles.length - 1];
			return {
				diff: [{ time: c.time, value: 0 }],
				maOffset, t0: 0, t1: 0, t2: 0, t3: 0, t4: 0,
				c0: c, c1: c, c2: c, c3: c, c4: c, bars: 1, phase: 'low',
				extrema: [], fibStart: c.low, legSize: Math.max(1e-9, c.high - c.low),
				rayStartPrice: c.low, rayEndPrice: c.low, t2Price: c.close, signalBuy: false,
				f1: 0, f2: 0, f3: 0, f4: 0, f5: 0, f6: 0, f7: 'Low · t2→t4 Δ=+0.000', cycleAvg: 0,
			};
		}
		const cycle = resolveCycle(diff);
		const t0 = clampIndex(cycle.t0, cycle.maxDiffIdx);
		const t1 = cycle.t1;
		const t2 = cycle.t2;
		const t3 = cycle.t3;
		const t4 = cycle.t4;
		const phase = cycle.phase;
		const c0 = candles[clampIndex(t0 + maOffset, candles.length - 1)];
		const c1 = candles[clampIndex(t1 + maOffset, candles.length - 1)];
		const c2 = candles[clampIndex(t2 + maOffset, candles.length - 1)];
		const c3 = candles[clampIndex(t3 + maOffset, candles.length - 1)];
		const c4 = candles[clampIndex(t4 + maOffset, candles.length - 1)];
		const bars = (t1 - t0) || 1;
		const lowCycle = phase === 'low';
		const fibStart = lowCycle ? c0.low : c0.high;
		const fibEnd = lowCycle ? c2.high : c2.low;
		const legSize = (fibEnd - fibStart) || 1e-9;
		const oneThirdEnd = t1 + Math.max(1, Math.round(bars / 3));
		const zeroNineLen = Math.max(1, Math.round(bars * 0.09));

		// extrema markers: every f' zero crossing
		const extrema = [];
		for (let i = 1; i < diff.length; i++) {
			const a = diff[i - 1].value;
			const b = diff[i].value;
			if ((a <= 0 && b > 0) || (a >= 0 && b < 0)) {
				extrema.push({ time: diff[i].time, low: a <= 0 && b > 0 });
			}
		}

		return {
			diff, maOffset, t0, t1, t2, t3, t4, c0, c1, c2, c3, c4, bars, phase, extrema,
			fibStart, legSize,
			rayStartPrice: lowCycle ? c0.low : c0.high,
			rayEndPrice: lowCycle ? c1.high : c1.low,
			t2Price: lowCycle ? c2.high : c2.low,
			signalBuy: !lowCycle,
			// 1. difference quotient t0→t1
			f1: differenceQuotient(lowCycle ? c0.low : c0.high, lowCycle ? c1.high : c1.low, bars, scale),
			// 2. difference quotient at t0
			f2: differenceQuotient(
				lowCycle ? c0.low : c0.high,
				candles[clampIndex(t0 + maOffset + 1, candles.length - 1)].close,
				1,
				scale
			),
			// 3. live differential quotient of MA
			f3: diff[diff.length - 1].value,
			// 4. differential quotient at t2 (f' ~= 1 cycle snap)
			f4: diff[t2].value,
			// 5. differential quotient at t3 (f' ~= -1 / +1 reversed)
			f5: diff[t3].value,
			// 6. differential quotient at t4 (f' ~= 0 snap)
			f6: diff[t4].value,
			// 7. phase summary
			f7: (phase === 'low' ? 'Low' : 'High') + ' · t2→t4 Δ=' + fmtDiff(avgDifferential(diff, t1, oneThirdEnd)),
			cycleAvg: avgDifferential(diff, diff.length - zeroNineLen, diff.length),
		};
	}

	// ---- UI helpers ----
	function showError(host, msg) {
		host.innerHTML = '<p style="padding:16px;color:#ef5350">' + msg + '</p>';
	}

	function showLoading(host) {
		host.innerHTML = '<p style="padding:16px;color:rgba(255,255,255,0.5)">Marktdaten werden geladen\u2026</p>';
	}

	// ---- chart setup ----
	function buildChart(LWC, host, candles) {
		host.innerHTML = '';
		const chart = LWC.createChart(host, {
			autoSize: true,
			layout: {
				background: { type: 'solid', color: 'transparent' },
				textColor: COLORS.text,
				fontFamily: '"Segoe UI", system-ui, sans-serif',
			},
			grid: {
				vertLines: { color: COLORS.grid },
				horzLines: { color: COLORS.grid },
			},
			crosshair: {
				mode: LWC.CrosshairMode.Magnet,
				vertLine: { color: COLORS.blue, labelBackgroundColor: COLORS.blueAccent },
				horzLine: { color: COLORS.blue, labelBackgroundColor: COLORS.blueAccent },
			},
			handleScale: {
				mouseWheel: true,
				pinch: true,
				axisPressedMouseMove: true,
			},
			handleScroll: {
				mouseWheel: true,
				pressedMouseMove: true,
				horzTouchDrag: true,
				vertTouchDrag: false,
			},
			timeScale: {
				borderColor: 'rgba(255,255,255,0.12)',
				timeVisible: true,
				rightOffset: 4,
			},
			leftPriceScale: { visible: false, borderColor: 'rgba(255,255,255,0.12)' },
			rightPriceScale: { borderColor: 'rgba(255,255,255,0.12)' },
		});

		const ma = movingAverage(candles, CONFIG.maPeriod);
		const result = analyze(candles, ma);

		const candleSeries = chart.addSeries(LWC.CandlestickSeries, {
			upColor: COLORS.greenSoft,
			downColor: COLORS.red,
			borderUpColor: COLORS.greenSoft,
			borderDownColor: COLORS.red,
			wickUpColor: COLORS.greenSoft,
			wickDownColor: COLORS.red,
		});
		candleSeries.setData(candles);

		const maSeries = chart.addSeries(LWC.LineSeries, {
			color: COLORS.blue,
			lineWidth: 2,
			priceLineVisible: false,
			lastValueVisible: false,
		});
		maSeries.setData(ma);

		const raySeries = chart.addSeries(LWC.LineSeries, {
			color: COLORS.orange,
			lineWidth: 1,
			lineStyle: LWC.LineStyle.Dashed,
			priceLineVisible: false,
			lastValueVisible: false,
			crosshairMarkerVisible: false,
		});
		const slopePerBar = (result.rayEndPrice - result.rayStartPrice) / result.bars;
		const i0 = result.t0 + result.maOffset;
		const rayData = [];
		for (let i = i0; i < candles.length; i++) {
			rayData.push({ time: candles[i].time, value: result.rayStartPrice + slopePerBar * (i - i0) });
		}
		raySeries.setData(rayData);

		// fibonacci price lines on the candle series
		let fibLines = [];
		function paintFib() {
			fibLines = FIB_LEVELS.map(level => candleSeries.createPriceLine({
				price: result.fibStart + result.legSize * level,
				color: level === 1.618 ? COLORS.blue : (level === 0.5 ? COLORS.green : COLORS.orange),
				lineWidth: level === 1.618 ? 2 : 1,
				lineStyle: LWC.LineStyle.Dotted,
				axisLabelVisible: true,
				title: String(level),
			}));
		}
		function clearFib() {
			fibLines.forEach(line => candleSeries.removePriceLine(line));
			fibLines = [];
		}
		paintFib();

		// t0/t1/t2/t3/t4 markers + extrema markers
		const baseMarkers = [
			{
				time: result.c0.time,
				position: result.phase === 'low' ? 'belowBar' : 'aboveBar',
				color: COLORS.green,
				shape: 'circle',
				text: 't0',
			},
			{
				time: result.c1.time,
				position: result.phase === 'low' ? 'aboveBar' : 'belowBar',
				color: COLORS.orange,
				shape: 'circle',
				text: 't1',
			},
			{
				time: result.c2.time,
				position: result.signalBuy ? 'belowBar' : 'aboveBar',
				color: COLORS.blue,
				shape: result.signalBuy ? 'arrowUp' : 'arrowDown',
				text: 't2 ' + result.t2Price.toFixed(4),
			},
			{
				time: result.c3.time,
				position: result.phase === 'low' ? 'belowBar' : 'aboveBar',
				color: COLORS.orange,
				shape: 'circle',
				text: 't3',
			},
			{
				time: result.c4.time,
				position: result.phase === 'low' ? 'aboveBar' : 'belowBar',
				color: COLORS.green,
				shape: 'circle',
				text: 't4',
			},
		];
		const extremaMarkers = result.extrema.map(e => ({
			time: e.time,
			position: e.low ? 'belowBar' : 'aboveBar',
			color: e.low ? COLORS.green : COLORS.orange,
			shape: 'circle',
			size: 0.6,
		}));
		const markers = LWC.createSeriesMarkers(candleSeries, baseMarkers);

		chart.timeScale().fitContent();

		// ---- formula readouts ----
		document.getElementById('f1').textContent = fmtDiff(result.f1);
		document.getElementById('f2').textContent = fmtDiff(result.f2);
		document.getElementById('f3').textContent = fmtDiff(result.f3);
		document.getElementById('f4').textContent = fmtDiff(result.f4);
		document.getElementById('f5').textContent = fmtDiff(result.f5);
		document.getElementById('f6').textContent = fmtDiff(result.f6)
			+ (Math.abs(result.cycleAvg) > THRESHOLD ? ' \u2192 n\u00e4chstes Fib' : '');
		document.getElementById('f7').textContent = result.f7;

		const signalCard = document.getElementById('signalCard');
		const signalOut = document.getElementById('signal');
		signalCard.classList.remove('buy', 'sell');
		signalCard.classList.add(result.signalBuy ? 'buy' : 'sell');
		signalOut.textContent = (result.signalBuy ? 'BUY @ ' : 'SELL @ ') + result.t2Price.toFixed(4);

		// ---- paint toggles ----
		document.getElementById('toggleRay').addEventListener('change', e => {
			raySeries.applyOptions({ visible: e.target.checked });
		});
		document.getElementById('toggleFib').addEventListener('change', e => {
			if (e.target.checked) { paintFib(); } else { clearFib(); }
		});
		function refreshMarkers() {
			const showDots = document.getElementById('toggleDots').checked;
			const showExtrema = document.getElementById('toggleExtrema').checked;
			const list = []
				.concat(showDots ? baseMarkers : [])
				.concat(showExtrema ? extremaMarkers : [])
				.sort((a, b) => a.time - b.time);
			markers.setMarkers(list);
		}
		document.getElementById('toggleDots').addEventListener('change', refreshMarkers);
		document.getElementById('toggleExtrema').addEventListener('change', refreshMarkers);
		document.getElementById('toggleGrid').addEventListener('change', e => {
			const visible = e.target.checked;
			chart.applyOptions({
				grid: {
					vertLines: { visible, color: COLORS.grid },
					horzLines: { visible, color: COLORS.grid },
				},
			});
		});
		document.getElementById('toggleLeftScale').addEventListener('change', e => {
			chart.applyOptions({
				leftPriceScale: { visible: e.target.checked, borderColor: 'rgba(255,255,255,0.12)' },
			});
		});
		document.getElementById('togglePriceLabels').addEventListener('change', e => {
			const visible = e.target.checked;
			candleSeries.applyOptions({ priceLineVisible: visible, lastValueVisible: visible });
			maSeries.applyOptions({ priceLineVisible: visible, lastValueVisible: visible });
		});
		document.getElementById('crosshairMode').addEventListener('change', e => {
			const mode = e.target.value === 'normal' ? LWC.CrosshairMode.Normal : LWC.CrosshairMode.Magnet;
			chart.applyOptions({ crosshair: { mode } });
		});
		refreshMarkers();

		return candleSeries;
	}

	// ---- live polling: update last bar, add new bar on period rollover ----
	function startLivePolling(candleSeries, initialCandles) {
		let lastTime = initialCandles[initialCandles.length - 1].time;
		const poll = async () => {
			let fresh;
			try {
				fresh = await fetchKrakenOHLC(CONFIG.pair, CONFIG.interval);
			} catch (e) {
				setTimeout(poll, CONFIG.pollMs); // retry after interval on error
				return;
			}
			if (fresh.length) {
				const newBar = fresh[fresh.length - 1];
				if (newBar.time !== lastTime) {
					// period rolled over: commit the now-complete previous bar first
					const prevBar = fresh[fresh.length - 2];
					if (prevBar && prevBar.time === lastTime) {
						candleSeries.update(prevBar);
					}
					candleSeries.update(newBar);
					lastTime = newBar.time;
				} else {
					candleSeries.update(newBar);
				}
			}
			setTimeout(poll, CONFIG.pollMs);
		};
		setTimeout(poll, CONFIG.pollMs);
	}

	// ---- entry point ----
	async function init() {
		const LWC = window.LightweightCharts;
		const host = document.getElementById('chart');
		if (!LWC || !host) {
			if (host) { showError(host, 'lightweight-charts konnte nicht geladen werden.'); }
			return;
		}

		// update symbol pill from config
		document.getElementById('symbolPill').textContent =
			CONFIG.displayName + ' \u00b7 ' + CONFIG.intervalLabel;

		showLoading(host);

		let candles;
		try {
			candles = await fetchKrakenOHLC(CONFIG.pair, CONFIG.interval);
		} catch (e) {
			showError(host, 'Marktdaten konnten nicht geladen werden: ' + e.message);
			return;
		}

		const candleSeries = buildChart(LWC, host, candles);
		startLivePolling(candleSeries, candles);
	}

	init();
})();
