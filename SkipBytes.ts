import * as stream from "stream";

// Adapted from stream-skip
// https://github.com/Ivshti/stream-skip
export class SkipBytes extends stream.Transform {
    constructor(private _toSkip: number) {
        super({})
    }

    _transform(chunk, enc, cb) {
        if (this._toSkip == 0) this.push(chunk);
        else if (this._toSkip > chunk.length) {
            this._toSkip -= chunk.length;
        } else {
            if (this._toSkip !== chunk.length) {
                this.push(chunk.slice(this._toSkip))
            }
            this._toSkip = 0;
        }
        cb();
    }
}