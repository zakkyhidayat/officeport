package io.github.officeport.android;

import android.content.Context;
import android.view.textservice.SentenceSuggestionsInfo;
import android.view.textservice.SpellCheckerSession;
import android.view.textservice.SuggestionsInfo;
import android.view.textservice.TextInfo;
import android.view.textservice.TextServicesManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.Locale;

/**
 * Electron's spell checker (the misspelled word and suggestions of a context
 * menu) answered by Android's: the system spell checker the keyboard uses,
 * which also draws WebView's underlines. One word at a time, in order.
 */
final class Spelling implements SpellCheckerSession.SpellCheckerSessionListener {
    interface Result {
        void done(JSONObject result);
    }

    private static final class Job {
        final String word;
        final Result result;

        Job(String word, Result result) {
            this.word = word;
            this.result = result;
        }
    }

    private final Context context;
    private SpellCheckerSession session;
    private Locale locale;
    private final ArrayDeque<Job> queue = new ArrayDeque<>();
    private Job current;

    Spelling(Context context) {
        this.context = context;
    }

    /** Checks one word; called on the main thread, answers on it. */
    void check(String word, String language, Result result) {
        Locale wanted = language == null || language.isEmpty() ? Locale.getDefault() : Locale.forLanguageTag(language);
        if (session == null || !wanted.equals(locale)) {
            if (session != null) session.close();
            TextServicesManager tsm = (TextServicesManager) context.getSystemService(Context.TEXT_SERVICES_MANAGER_SERVICE);
            locale = wanted;
            session = tsm == null ? null : tsm.newSpellCheckerSession(null, wanted, this, language == null || language.isEmpty());
        }
        if (session == null) {
            result.done(answer(word, false, new JSONArray()));
            return;
        }
        queue.add(new Job(word, result));
        next();
    }

    private void next() {
        if (current != null || queue.isEmpty()) return;
        current = queue.poll();
        session.getSentenceSuggestions(new TextInfo[]{new TextInfo(current.word)}, 6);
    }

    private static JSONObject answer(String word, boolean misspelled, JSONArray suggestions) {
        try {
            return new JSONObject().put("word", word).put("misspelled", misspelled).put("suggestions", suggestions);
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    @Override
    public void onGetSentenceSuggestions(SentenceSuggestionsInfo[] results) {
        Job job = current;
        current = null;
        if (job == null) return;
        boolean misspelled = false;
        JSONArray suggestions = new JSONArray();
        if (results != null) {
            for (SentenceSuggestionsInfo sentence : results) {
                if (sentence == null) continue;
                for (int i = 0; i < sentence.getSuggestionsCount(); i++) {
                    SuggestionsInfo info = sentence.getSuggestionsInfoAt(i);
                    int attrs = info.getSuggestionsAttributes();
                    if ((attrs & SuggestionsInfo.RESULT_ATTR_IN_THE_DICTIONARY) == 0
                            && (attrs & SuggestionsInfo.RESULT_ATTR_LOOKS_LIKE_TYPO) != 0) {
                        misspelled = true;
                    }
                    for (int k = 0; k < info.getSuggestionsCount(); k++) suggestions.put(info.getSuggestionAt(k));
                }
            }
        }
        job.result.done(answer(job.word, misspelled, misspelled ? suggestions : new JSONArray()));
        next();
    }

    @Override
    public void onGetSuggestions(SuggestionsInfo[] results) {
        // only sentence suggestions are requested
    }

    void close() {
        if (session != null) session.close();
        session = null;
    }
}
