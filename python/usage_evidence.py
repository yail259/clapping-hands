"""Numeric telemetry only; never serialize provider messages or credentials."""
def usage_event(request_attempts, summary):
    def count(name):
        value = getattr(summary, name, None)
        return value if type(value) is int and 0 <= value <= 9007199254740991 else None
    invocations = count('entry_count')
    prompt = count('total_prompt_tokens')
    completion = count('total_completion_tokens')
    return {
        'kind': 'browser-use-usage',
        'requestAttempts': request_attempts,
        'reportedInvocations': invocations,
        'promptTokens': prompt,
        'completionTokens': completion,
        'cachedPromptTokens': count('total_prompt_cached_tokens'),
        'tokenCoverageComplete': invocations == request_attempts and prompt is not None and completion is not None,
        # Browser Use's default cost=0 means pricing disabled, not free usage.
        'costUSD': None,
    }
