"""These tests validate the numerical benchmark, never label random vectors as semantics."""
import importlib.util
import sys
from pathlib import Path
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'runtime/vector-service'))
spec = importlib.util.spec_from_file_location('vector_benchmark', ROOT / 'runtime/vector-service/benchmark.py')
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)


def test_percentiles_and_true_wall_throughput():
    assert benchmark.summarize([10, 20, 30, 40], 0.1, 0.02)['p95Ms'] == 40
    assert benchmark.summarize([10, 20, 30, 40], 0.1, 0.02)['throughputPerSecond'] == 40
    with pytest.raises(ValueError):
        benchmark.summarize([], 0.1, 0)


def test_random_baseline_is_deterministic_and_has_independent_numerical_truth(tmp_path):
    result = benchmark.validate_numerics(tmp_path)
    assert result['numericalCorrectness'] is True
    assert result['semanticQualityMeasured'] is False
    assert result['selectedChunkIds'] == ['east', 'north']


def test_output_guard_refuses_real_library_or_arbitrary_directory():
    with pytest.raises(ValueError):
        benchmark.safe_output(Path('/home/bandoo/workspace/knowledge/doo-konw'))
    with pytest.raises(ValueError):
        benchmark.safe_output(Path('/tmp/numeric-index'))
