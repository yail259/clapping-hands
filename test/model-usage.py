import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from usage_evidence import usage_event

class UsageTest(unittest.TestCase):
    def test_summary(self):
        summary=SimpleNamespace(entry_count=2,total_prompt_tokens=100,total_completion_tokens=20,total_prompt_cached_tokens=10,total_cost=0,secret='never-export')
        result=usage_event(2,summary)
        self.assertTrue(result['tokenCoverageComplete'])
        self.assertIsNone(result['costUSD'])
        self.assertNotIn('never-export', str(result))
        self.assertFalse(usage_event(3,summary)['tokenCoverageComplete'])
    def test_missing(self):
        result=usage_event(2,None)
        self.assertEqual(result['requestAttempts'],2)
        self.assertIsNone(result['promptTokens'])
        self.assertFalse(result['tokenCoverageComplete'])
        self.assertIsNone(usage_event(1,SimpleNamespace(total_prompt_tokens=True))['promptTokens'])

if __name__ == '__main__': unittest.main()
