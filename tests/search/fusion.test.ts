import {it,expect} from 'vitest';
import {rrf} from '../../packages/core/search/fusion.js';
it('combines ranks instead of incompatible numeric scores',()=>{const result=rrf([{chunkId:'both',rank:2,score:-100},{chunkId:'text',rank:1,score:-10000}],[{chunkId:'both',rank:2,score:.1},{chunkId:'vector',rank:1,score:.99}]);expect(result[0].chunkId).toBe('both');expect(result[0].score).toBeCloseTo(2/62);expect(result[0].matchedBy).toEqual(['text','semantic']);});
