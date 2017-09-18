/*!

Copyright (c) 2015 Eric Chan

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

*/

(function () {
	'use strict';

	var MThd = 1297377380;
	var MTrk = 1297379947;

	/*
	take a byte array of midi events and convert them to an array standard javascript objects
	*/
	function parseevents(chunk) {
		var events = [];
		var i = 0;
		var ch;
		var time = 0;
		var command = 0;
		var CMDLEN = [0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 2, 1, 1, 2, 0];

		while (i < chunk.length) {

			var delay = 0;
			do {
				ch = chunk[i++];
				delay <<= 7;
				delay |= ch & 0x7f;
			} while (ch & 0x80);

			time += delay;

			// ----

			var ch = chunk[i];

			if (ch == 0xff) { // meta
				var p = 2;
				var len = 0;
				do {
					ch = chunk[i + p++];
					len <<= 7;
					len |= ch & 0x7f;
				} while (ch & 0x80);

				var evt = { time: time, command: chunk.subarray(i, i + p + len) };
				events.push(evt);
				i += p + len;
				command = 0;
				continue;
			} else if (ch == 0xf0) { // sysex
				var len = 1;
				while (chunk[i + len++] != 0xf7); // <-- that semicolon should be there
				var evt = { time: time, command: chunk.subarray(i, i + len) };
				events.push(evt);
				i += len;
				command = 0;
				continue;
			} else if ((ch & 0x80) != 0) {
				command = ch;
				i++;
			}

			if ((command & 0x80) == 0) {
				throw ['command error', 'index', i, 'track', chunk];
			}

			var l = CMDLEN[command >> 4];
			if (l > 0) {
				var evt = { time: time, command: [command].concat(Array.prototype.slice.call(chunk.subarray(i, i + l))), };
				events.push(evt);
				i += l;
			}
		}

		return events;
	}

	/*
	given a song and chunk, parse and add the chunk to the song
	*/
	function handlechunk(song, type, chunk) {
		if (type === MThd) {
			song.format = vtos(chunk.subarray(0));
			song.numtracks = vtos(chunk.subarray(2));
			song.divisions = vtos(chunk.subarray(4));
			return;
		}

		if (type == MTrk) {
			try {
				song.tracks.push(parseevents(chunk));
			} catch (e) {
				console.warn.apply(console, e);
			}
			return;
		}

		console.warn('discarding unknown chunk', type, chunk);
	}

	/*
	integer functions for byte arrays
	*/

	function vtos(v) {
		return (v[1] | v[0] << 8) >>> 0;
	}

	function vtol(v) {
		return (v[3] | v[2] << 8 | v[1] << 16 | v[0] << 24) >>> 0;
	}

	function stov(s) {
		return [s >> 8 & 0xff, s & 0xff];
	}

	function ltov(l) {
		return [l >> 24 & 0xff, l >> 16 & 0xff, l >> 8 & 0xff, l & 0xff];
	}

	function ltobb(n) {
		var v = [n & 0x7f];
		n >>= 7;
		while (n) {
			v.unshift(0x80 | (n & 0x7f));
			n >>= 7;
		}
		return v;
	}

	/*
	create a chunk of a given type from a payload
	*/
	function chunkify(type, data) {
		return ltov(type).concat(ltov(data.length)).concat(data);
	}

	/*
	given a serialized file, decode it into a song object
	*/
	function decode(buffer) {
		var file = new Uint8Array(buffer);

		var song = {
			tracks: [],
		};

		var remainder = file;

		while (remainder.length > 0) {
			var type = vtol(remainder.subarray(0, 4));
			var size = vtol(remainder.subarray(4, 8));
			var chunk = remainder.subarray(8, 8 + size);

			console.assert(size == chunk.length, 'chunk length does not match size of chunk data (probably a bad file)');
			handlechunk(song, type, chunk);

			remainder = remainder.subarray(8 + size);
		}

		console.assert(song.numtracks == song.tracks.length, 'number of tracks reported does not match number of tracks read');
		console.assert(!(song.type == 0) || (song.tracks.length == 1), 'type 0 file with num tracks != 1');

		delete song.numtracks; // clear out redundant data
		return song;
	}

	/*
	given a song object, serialize it
	*/
	function encode(song) {
		var file = [];
		var i, j;
		try {
			var type = (song.tracks.length == 1)?0:1;
			file = chunkify(MThd, [0, type].concat(stov(song.tracks.length)).concat(stov(song.divisions)) );
			
			for (i = 0; i < song.tracks.length; i++) {
				var track = song.tracks[i].sort(function (a, b) {
					return b.time < a.time;
				});

				track[0].delta = track[0].time;

				for (j = 1; j < track.length; j++) {
					track[j].delta = track[j].time - track[j - 1].time;
				}

				var chunk = chunkify(MTrk, [].concat.apply([], track.map(function (cmd) {
					return ltobb(cmd.delta).concat(Array.prototype.slice.call(cmd.command));
				})));

				file = file.concat(chunk);
			}

		} catch (e) {
			console.warn(e);
			return;
		}

		return new Uint8Array(file);
	}

	/*
	create a new song object
	*/
	function create() {
		var mtempo = 120;
		var divs = 60000 / mtempo; // ms per quarter
		var stempo = 60000000 / mtempo; // us per quarter
	
		var song = {
			divisions: divs,
			tracks: [
				[
					{ time: 0, command: [ 0xff, 0x51, 3, (stempo >> 16) & 0xff, (stempo >> 8) & 0xff, (stempo >> 0) & 0xff ], },
				],
			]
		};

		return song;
	}

	window.Noon = { // something something global
		decode: decode,
		encode: encode,
		create: create,
	}
}())
