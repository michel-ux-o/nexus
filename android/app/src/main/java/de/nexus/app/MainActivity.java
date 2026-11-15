package de.nexus.app;

import android.annotation.SuppressLint;
import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.BroadcastReceiver;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.ServiceWorkerController;
import android.webkit.WebChromeClient;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.PermissionRequest;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.ValueCallback;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONException;
import org.json.JSONObject;

import java.time.Instant;
import java.time.ZoneId;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Hosted Nexus with a main-frame-only, origin-bound native alarm channel. */
public final class MainActivity extends Activity {
    public static final String ACTION_OPEN_MORNING = "de.nexus.app.OPEN_MORNING";
    public static final String EXTRA_MORNING_REQUEST_ID = "morning_request_id";
    private static final String CHANNEL = "nexus.android.alarm";
    private static final String PREFERENCES = "nexus_morning_request";
    private static final String REQUEST_ID = "requestId";
    private static final String REQUESTED_AT = "requestedAt";
    private static final String LOCAL_DATE = "localDate";
    private static final int BACKGROUND = Color.rgb(17, 27, 34);
    private static final int PICK_UPLOAD_DOCUMENT = 1861;
    private static final int CREATE_TEXT_DOCUMENT = 1862;
    private static final int REQUEST_MICROPHONE = 1863;
    private static final int MAX_TEXT_DOCUMENT_BYTES = 20 * 1024 * 1024;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService documentWriter = Executors.newSingleThreadExecutor();
    private ValueCallback<Uri[]> fileChooserCallback;
    private boolean fileChooserMultiple;
    private PendingDocumentExport pendingDocumentExport;
    private PermissionRequest microphoneRequest;
    private Button stopAlarmButton;
    private boolean alarmStateReceiverRegistered;
    private final BroadcastReceiver alarmStateReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) { refreshAlarmControl(); }
    };
    private WebView webView;
    private LinearLayout root;
    private LinearLayout errorPanel;
    private TextView errorMessage;
    private Button retryButton;
    private ProgressBar progressBar;
    private WebMessagePort nativePort;
    private boolean trustedDocument;
    private boolean bridgeAcknowledged;
    private boolean pageFailed;
    private int bridgeAttempts;
    private static final class PendingDocumentExport {
        final WebMessagePort port;
        final String id;
        final byte[] bytes;
        PendingDocumentExport(WebMessagePort port, String id, byte[] bytes) {
            this.port = port;
            this.id = id;
            this.bytes = bytes;
        }
    }
    private final Runnable bridgeRetry = () -> {
        if (trustedDocument && !bridgeAcknowledged && bridgeAttempts < 6) connectBridge();
    };

    /** Only native code creates a persisted request; exported launch extras alone do nothing. */
    public static Intent morningRoutineIntent(Context context) {
        long requestedAt = System.currentTimeMillis();
        String requestId = UUID.randomUUID().toString();
        String localDate = Instant.ofEpochMilli(requestedAt).atZone(ZoneId.systemDefault()).toLocalDate().toString();
        boolean saved = context.getSharedPreferences(PREFERENCES, MODE_PRIVATE).edit()
                .putString(REQUEST_ID, requestId)
                .putLong(REQUESTED_AT, requestedAt)
                .putString(LOCAL_DATE, localDate)
                .commit();
        if (!saved) throw new IllegalStateException("Der Start der Morgenroutine konnte nicht gespeichert werden. Bitte erneut versuchen.");
        return new Intent(context, MainActivity.class)
                .setAction(ACTION_OPEN_MORNING)
                .putExtra("openMorningRoutine", true)
                .putExtra(EXTRA_MORNING_REQUEST_ID, requestId)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildLayout();
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::navigateBack);
        }
        if (BuildConfig.NEXUS_ORIGIN.isEmpty()) {
            showError(R.string.configuration_error, false);
            return;
        }
        try {
            configureWebView();
            loadNexus();
        } catch (RuntimeException unavailableWebView) {
            showError(R.string.webview_error, false);
        }
    }

    private void buildLayout() {
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(BACKGROUND);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                Insets safe = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
                return insets;
            });
        } else {
            root.setFitsSystemWindows(true);
        }

        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.setPadding(dp(12), dp(2), dp(8), dp(2));
        TextView title = new TextView(this);
        title.setText(R.string.app_name);
        title.setTextColor(Color.WHITE);
        title.setTextSize(20);
        toolbar.addView(title, new LinearLayout.LayoutParams(0, dp(52), 1));
        title.setGravity(Gravity.CENTER_VERTICAL);
        Button alarmButton = new Button(this);
        alarmButton.setText(R.string.native_alarm);
        alarmButton.setContentDescription(getString(R.string.native_alarm));
        alarmButton.setOnClickListener(view -> openAlarmSettings());
        toolbar.addView(alarmButton, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(48)));
        stopAlarmButton = new Button(this);
        stopAlarmButton.setText("Wecker stoppen");
        stopAlarmButton.setVisibility(View.GONE);
        stopAlarmButton.setOnClickListener(view -> confirmStopAlarm());
        toolbar.addView(stopAlarmButton, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(48)));
        root.addView(toolbar);

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        root.addView(progressBar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(2)));

        FrameLayout content = new FrameLayout(this);
        root.addView(content, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        errorPanel = new LinearLayout(this);
        errorPanel.setOrientation(LinearLayout.VERTICAL);
        errorPanel.setGravity(Gravity.CENTER);
        errorPanel.setPadding(dp(24), dp(24), dp(24), dp(24));
        errorPanel.setBackgroundColor(BACKGROUND);
        errorMessage = new TextView(this);
        errorMessage.setTextColor(Color.WHITE);
        errorMessage.setTextSize(17);
        errorMessage.setGravity(Gravity.CENTER);
        errorPanel.addView(errorMessage);
        retryButton = new Button(this);
        retryButton.setText(R.string.reload);
        retryButton.setOnClickListener(view -> loadNexus());
        LinearLayout.LayoutParams retryLayout = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        retryLayout.topMargin = dp(16);
        errorPanel.addView(retryButton, retryLayout);
        errorPanel.setVisibility(View.GONE);
        content.addView(errorPanel, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        root.requestApplyInsets();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        webView = new WebView(this);
        webView.setBackgroundColor(BACKGROUND);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setGeolocationEnabled(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSafeBrowsingEnabled(true);
        ServiceWorkerController.getInstance().getServiceWorkerWebSettings().setAllowFileAccess(false);
        ServiceWorkerController.getInstance().getServiceWorkerWebSettings().setAllowContentAccess(false);
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, false);
        // First-party HttpOnly session cookies stay in WebView; no token or cookie bridge.
        webView.setWebViewClient(new NexusWebViewClient());
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int progress) {
                progressBar.setProgress(progress);
                progressBar.setVisibility(progress == 100 || pageFailed ? View.GONE : View.VISIBLE);
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // Only audio capture from the hosted app can prompt for Android permission.
                // Never grant video, MIDI, protected media or a foreign frame's request.
                String[] resources = request.getResources();
                if (!trustedDocument || webView == null || !isNexusUrl(webView.getUrl()) ||
                        !isNexusOrigin(request.getOrigin()) || resources.length != 1 ||
                        !PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resources[0]) || microphoneRequest != null) {
                    request.deny();
                    return;
                }
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                    return;
                }
                microphoneRequest = request;
                requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQUEST_MICROPHONE);
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                if (microphoneRequest == request) microphoneRequest = null;
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (!trustedDocument || view != webView || !isNexusUrl(view.getUrl()) ||
                        fileChooserCallback != null || pendingDocumentExport != null ||
                        (params.getMode() != FileChooserParams.MODE_OPEN && params.getMode() != FileChooserParams.MODE_OPEN_MULTIPLE)) {
                    callback.onReceiveValue(null);
                    return true;
                }
                fileChooserCallback = callback;
                fileChooserMultiple = params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE;
                Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                        .setType("*/*").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, fileChooserMultiple);
                ArrayList<String> mimeTypes = new ArrayList<>();
                for (String accept : params.getAcceptTypes()) {
                    if (accept == null) continue;
                    for (String type : accept.split(",")) {
                        type = type.trim().toLowerCase(Locale.ROOT);
                        if (".json".equals(type)) type = "application/json";
                        else if (".txt".equals(type)) type = "text/plain";
                        else if (".csv".equals(type)) type = "text/csv";
                        if (type.matches("[a-z0-9.+-]+/[a-z0-9.*+-]+")) mimeTypes.add(type);
                    }
                }
                if (!mimeTypes.isEmpty()) pick.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes.toArray(new String[0]));
                try {
                    startActivityForResult(pick, PICK_UPLOAD_DOCUMENT);
                } catch (ActivityNotFoundException | SecurityException unavailable) {
                    finishFileChooser(null);
                    Toast.makeText(MainActivity.this, "Die Dateiauswahl konnte nicht geöffnet werden.", Toast.LENGTH_LONG).show();
                }
                return true;
            }
        });
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            if (url != null) openExternal(Uri.parse(url));
        });
        FrameLayout content = (FrameLayout) errorPanel.getParent();
        content.addView(webView, 0, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void loadNexus() {
        if (webView == null || BuildConfig.NEXUS_ORIGIN.isEmpty()) return;
        resetBridge();
        pageFailed = false;
        errorPanel.setVisibility(View.GONE);
        progressBar.setVisibility(View.VISIBLE);
        webView.loadUrl(BuildConfig.NEXUS_ORIGIN + "/");
    }

    private boolean isNexusOrigin(Uri uri) {
        if (uri == null || !"https".equalsIgnoreCase(uri.getScheme()) || uri.getUserInfo() != null) return false;
        Uri origin = Uri.parse(BuildConfig.NEXUS_ORIGIN);
        return origin.getHost() != null && origin.getHost().equalsIgnoreCase(uri.getHost()) &&
                (uri.getPort() == -1 || uri.getPort() == 443);
    }

    private boolean isNexusUrl(String url) {
        return url != null && isNexusOrigin(Uri.parse(url));
    }

    private void openAlarmSettings() {
        startActivity(new Intent(this, AlarmSettingsActivity.class));
    }

    private void refreshAlarmControl() {
        if (stopAlarmButton != null) stopAlarmButton.setVisibility(AlarmService.isRinging() ? View.VISIBLE : View.GONE);
    }

    private void confirmStopAlarm() {
        String occurrence = AlarmService.occurrenceId();
        if (!AlarmService.isRinging() || occurrence == null) { refreshAlarmControl(); return; }
        new AlertDialog.Builder(this).setTitle("Wecker beenden?")
                .setMessage("Der aktuell klingelnde Wecker wird auf diesem Gerät beendet.")
                .setNegativeButton("Abbrechen", null)
                .setPositiveButton("Wecker stoppen", (dialog, which) -> {
                    startService(new Intent(this, AlarmService.class).setAction(AlarmService.ACTION_STOP)
                            .putExtra(AlarmService.EXTRA_OCCURRENCE, occurrence));
                    refreshAlarmControl();
                }).show();
    }

    private void openExternal(Uri uri) {
        String scheme = uri.getScheme();
        if (!"https".equalsIgnoreCase(scheme) && !"http".equalsIgnoreCase(scheme) &&
                !"mailto".equalsIgnoreCase(scheme) && !"tel".equalsIgnoreCase(scheme)) return;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (ActivityNotFoundException unavailable) {
            Toast.makeText(this, R.string.external_link_unavailable, Toast.LENGTH_SHORT).show();
        }
    }

    private void showError(int message, boolean retry) {
        resetBridge();
        pageFailed = true;
        progressBar.setVisibility(View.GONE);
        errorMessage.setText(message);
        retryButton.setVisibility(retry ? View.VISIBLE : View.GONE);
        errorPanel.setVisibility(View.VISIBLE);
    }

    private void resetBridge() {
        trustedDocument = false;
        bridgeAcknowledged = false;
        bridgeAttempts = 0;
        handler.removeCallbacks(bridgeRetry);
        PermissionRequest pendingMicrophone = microphoneRequest;
        microphoneRequest = null;
        if (pendingMicrophone != null) {
            try { pendingMicrophone.deny(); } catch (RuntimeException closedDocument) { /* Page already closed. */ }
        }
        finishFileChooser(null);
        // A navigation must never deliver an old file or write request to a new document.
        pendingDocumentExport = null;
        closeNativePort();
    }

    private void closeNativePort() {
        if (nativePort != null) {
            nativePort.close();
            nativePort = null;
        }
    }

    private void connectBridge() {
        if (!trustedDocument || pageFailed || webView == null || !isNexusUrl(webView.getUrl())) return;
        closeNativePort();
        WebMessagePort[] ports = webView.createWebMessageChannel();
        nativePort = ports[0];
        bridgeAttempts++;
        nativePort.setWebMessageCallback(new WebMessagePort.WebMessageCallback() {
            @Override
            public void onMessage(WebMessagePort port, WebMessage message) {
                if (port != nativePort || !trustedDocument || webView == null || !isNexusUrl(webView.getUrl())) return;
                handleBridgeMessage(port, message.getData());
            }
        });
        try {
            JSONObject handshake = envelope("connect");
            handshake.put("origin", BuildConfig.NEXUS_ORIGIN);
            // Android delivers this only to the main frame at this exact HTTPS origin.
            // No JavaScript object is injected into frames and no JavaScript string is evaluated.
            webView.postWebMessage(new WebMessage(handshake.toString(), new WebMessagePort[]{ports[1]}), Uri.parse(BuildConfig.NEXUS_ORIGIN));
            handler.postDelayed(bridgeRetry, 1500);
        } catch (JSONException | RuntimeException failedChannel) {
            closeNativePort();
        }
    }

    private JSONObject envelope(String type) throws JSONException {
        return new JSONObject().put("channel", CHANNEL).put("version", 1).put("type", type);
    }

    private void handleBridgeMessage(WebMessagePort port, String data) {
        // JSON can expand a 20 MiB string sixfold when control characters are escaped.
        if (data == null || data.length() > MAX_TEXT_DOCUMENT_BYTES * 6 + 8192) return;
        String id = null;
        try {
            JSONObject request = new JSONObject(data);
            Object rawId = request.opt("id");
            if (!(rawId instanceof String) || ((String) rawId).isEmpty() || ((String) rawId).length() > 128) return;
            id = (String) rawId;
            Object rawMethod = request.opt("method");
            if (!(rawMethod instanceof String)) {
                replyError(port, id, "invalid_request", "A method is required.");
                return;
            }
            if (!"saveTextDocument".equals(rawMethod) && data.length() > 8192) {
                replyError(port, id, "invalid_request", "The native request is too large.");
                return;
            }
            bridgeAcknowledged = true;
            handler.removeCallbacks(bridgeRetry);
            JSONObject result;
            switch ((String) rawMethod) {
                case "getCapabilities":
                    result = new JSONObject().put("platform", "android").put("nativeAlarm", true)
                            .put("bridgeVersion", 1).put("origin", BuildConfig.NEXUS_ORIGIN).put("textDocuments", true);
                    break;
                case "saveTextDocument":
                    saveTextDocument(port, id, request.optJSONObject("params"));
                    return;
                case "openAlarmSettings":
                    openAlarmSettings();
                    result = new JSONObject().put("opened", true);
                    break;
                case "consumeMorningRequest":
                    result = pendingMorningRequest();
                    break;
                case "acknowledgeMorningRequest":
                    JSONObject params = request.optJSONObject("params");
                    Object requestId = params == null ? null : params.opt("requestId");
                    SharedPreferences preferences = getSharedPreferences(PREFERENCES, MODE_PRIVATE);
                    String pendingId = preferences.getString(REQUEST_ID, null);
                    boolean acknowledged = requestId instanceof String && pendingId != null && pendingId.equals(requestId);
                    if (acknowledged) acknowledged = preferences.edit().clear().commit();
                    result = new JSONObject().put("acknowledged", acknowledged);
                    break;
                default:
                    replyError(port, id, "unsupported_method", "This native method is not supported.");
                    return;
            }
            replySuccess(port, id, result);
        } catch (JSONException malformed) {
            if (id != null) replyError(port, id, "invalid_request", "The native request is invalid.");
        } catch (RuntimeException unavailable) {
            if (id != null) replyError(port, id, "native_unavailable", "The native action could not be completed.");
        }
    }

    private void saveTextDocument(WebMessagePort port, String id, JSONObject params) throws JSONException {
        if (params == null || params.length() != 3 || !(params.opt("filename") instanceof String) ||
                !(params.opt("mimeType") instanceof String) || !(params.opt("text") instanceof String)) {
            replyError(port, id, "invalid_document", "The document is invalid.");
            return;
        }
        String filename = params.getString("filename");
        String mimeType = params.getString("mimeType");
        String text = params.getString("text");
        if (filename.trim().isEmpty() || filename.length() > 512 ||
                (!"application/json".equals(mimeType) && !"text/plain".equals(mimeType) && !"text/csv".equals(mimeType)) ||
                text.length() > MAX_TEXT_DOCUMENT_BYTES) {
            replyError(port, id, "invalid_document", "The document is invalid or too large.");
            return;
        }
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_TEXT_DOCUMENT_BYTES) {
            replyError(port, id, "document_too_large", "The document exceeds 20 MiB.");
            return;
        }
        if (pendingDocumentExport != null || fileChooserCallback != null) {
            replyError(port, id, "document_busy", "A document picker is already open.");
            return;
        }
        String safeName = filename.replaceAll("[\\p{Cntrl}\\\\/:*?\"<>|\\u202A-\\u202E\\u2066-\\u2069]", "_")
                .replaceAll("^\\.+", "").trim();
        if (safeName.length() > 120) safeName = safeName.substring(0, 120);
        if (safeName.isEmpty()) safeName = "Nexus";
        String extension = "application/json".equals(mimeType) ? ".json" : "text/csv".equals(mimeType) ? ".csv" : ".txt";
        if (!safeName.toLowerCase(Locale.ROOT).endsWith(extension)) safeName += extension;
        pendingDocumentExport = new PendingDocumentExport(port, id, bytes);
        try {
            startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .setType(mimeType).putExtra(Intent.EXTRA_TITLE, safeName)
                    .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION), CREATE_TEXT_DOCUMENT);
        } catch (ActivityNotFoundException | SecurityException unavailable) {
            pendingDocumentExport = null;
            replyError(port, id, "document_unavailable", "The document picker is unavailable.");
        }
    }

    private void finishFileChooser(Uri[] uris) {
        ValueCallback<Uri[]> callback = fileChooserCallback;
        fileChooserCallback = null;
        fileChooserMultiple = false;
        if (callback != null) {
            try { callback.onReceiveValue(uris); } catch (RuntimeException closedDocument) { /* Page already closed. */ }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == PICK_UPLOAD_DOCUMENT) {
            if (fileChooserCallback == null) return;
            if (resultCode != RESULT_OK || data == null || !trustedDocument || webView == null || !isNexusUrl(webView.getUrl())) {
                finishFileChooser(null);
                return;
            }
            ArrayList<Uri> selected = new ArrayList<>();
            if (data.getClipData() != null) {
                if (data.getClipData().getItemCount() > (fileChooserMultiple ? 16 : 1)) { finishFileChooser(null); return; }
                for (int index = 0; index < data.getClipData().getItemCount(); index++) selected.add(data.getClipData().getItemAt(index).getUri());
            } else if (data.getData() != null) selected.add(data.getData());
            try {
                for (Uri uri : selected) {
                    // Never expose file:// or an arbitrary native path to web content.
                    if (uri == null || !"content".equals(uri.getScheme()) || uri.getAuthority() == null ||
                            uri.getAuthority().equals(getPackageName())) throw new IOException("Unsupported document URI");
                    try (android.os.ParcelFileDescriptor readable = getContentResolver().openFileDescriptor(uri, "r")) {
                        if (readable == null) throw new IOException("Document unavailable");
                    }
                }
                finishFileChooser(selected.isEmpty() ? null : selected.toArray(new Uri[0]));
            } catch (IOException | SecurityException unavailable) {
                finishFileChooser(null);
                Toast.makeText(this, "Die ausgewählte Datei konnte nicht geöffnet werden.", Toast.LENGTH_LONG).show();
            }
            return;
        }
        if (requestCode != CREATE_TEXT_DOCUMENT) return;
        PendingDocumentExport pending = pendingDocumentExport;
        if (pending == null) return;
        if (pending.port != nativePort || !trustedDocument || webView == null || !isNexusUrl(webView.getUrl())) {
            pendingDocumentExport = null;
            return;
        }
        Uri uri = data == null ? null : data.getData();
        if (resultCode != RESULT_OK) {
            pendingDocumentExport = null;
            try { replySuccess(pending.port, pending.id, new JSONObject().put("status", "cancelled")); }
            catch (JSONException impossible) { /* Literal result cannot fail. */ }
            return;
        }
        if (uri == null || !"content".equals(uri.getScheme()) || uri.getAuthority() == null) {
            pendingDocumentExport = null;
            replyError(pending.port, pending.id, "invalid_document_uri", "The selected document is invalid.");
            return;
        }
        documentWriter.execute(() -> {
            try (OutputStream output = getContentResolver().openOutputStream(uri, "wt")) {
                if (output == null) throw new IOException("Document unavailable");
                output.write(pending.bytes);
                output.flush();
            } catch (IOException | RuntimeException failedWrite) {
                handler.post(() -> finishDocumentExport(pending, false));
                return;
            }
            handler.post(() -> finishDocumentExport(pending, true));
        });
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_MICROPHONE) return;
        PermissionRequest request = microphoneRequest;
        microphoneRequest = null;
        if (request == null) return;
        boolean granted = grantResults.length == 1 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (granted && trustedDocument && webView != null && isNexusUrl(webView.getUrl()) && isNexusOrigin(request.getOrigin())) {
            request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        } else request.deny();
    }

    private void finishDocumentExport(PendingDocumentExport pending, boolean saved) {
        if (pendingDocumentExport != pending) return;
        pendingDocumentExport = null;
        if (pending.port != nativePort || !trustedDocument) return;
        if (!saved) {
            replyError(pending.port, pending.id, "document_write_failed", "The document could not be saved.");
            return;
        }
        try { replySuccess(pending.port, pending.id, new JSONObject().put("status", "saved")); }
        catch (JSONException impossible) { /* Literal result cannot fail. */ }
    }

    private void replySuccess(WebMessagePort port, String id, JSONObject result) {
        try {
            port.postMessage(new WebMessage(new JSONObject().put("id", id).put("ok", true).put("result", result).toString()));
        } catch (JSONException | RuntimeException closedPort) {
            // A page navigation may close the channel while a system picker is open.
        }
    }

    private JSONObject pendingMorningRequest() throws JSONException {
        SharedPreferences preferences = getSharedPreferences(PREFERENCES, MODE_PRIVATE);
        String requestId = preferences.getString(REQUEST_ID, null);
        JSONObject result = new JSONObject().put("pending", requestId != null);
        if (requestId != null) result.put("requestId", requestId)
                .put("requestedAt", preferences.getLong(REQUESTED_AT, 0))
                .put("localDate", preferences.getString(LOCAL_DATE, ""));
        return result;
    }

    private void replyError(WebMessagePort port, String id, String code, String message) {
        try {
            port.postMessage(new WebMessage(new JSONObject().put("id", id).put("ok", false)
                    .put("error", new JSONObject().put("code", code).put("message", message)).toString()));
        } catch (JSONException | RuntimeException closedPort) {
            // Navigation may close a port while a reply is being dispatched.
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String pendingId = getSharedPreferences(PREFERENCES, MODE_PRIVATE).getString(REQUEST_ID, null);
        if (pendingId == null || !pendingId.equals(intent.getStringExtra(EXTRA_MORNING_REQUEST_ID))) return;
        if (!ACTION_OPEN_MORNING.equals(intent.getAction()) && !intent.getBooleanExtra("openMorningRoutine", false)) return;
        if (nativePort != null && trustedDocument) {
            try {
                nativePort.postMessage(new WebMessage(envelope("morning-pending").toString()));
            } catch (JSONException | RuntimeException closedPort) {
                // The persisted request is delivered after the next page handshake.
            }
        }
    }

    @Override
    protected void onPause() {
        if (webView != null) {
            webView.onPause();
            CookieManager.getInstance().flush();
        }
        super.onPause();
    }

    @Override
    protected void onStart() {
        super.onStart();
        IntentFilter filter = new IntentFilter(AlarmService.ACTION_STATE);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(alarmStateReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(alarmStateReceiver, filter);
        alarmStateReceiverRegistered = true;
        refreshAlarmControl();
    }

    @Override
    protected void onStop() {
        if (alarmStateReceiverRegistered) unregisterReceiver(alarmStateReceiver);
        alarmStateReceiverRegistered = false;
        super.onStop();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
        refreshAlarmControl();
    }

    @Override
    public void onBackPressed() {
        navigateBack();
    }

    private void navigateBack() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else finish();
    }

    @Override
    protected void onDestroy() {
        resetBridge();
        documentWriter.shutdownNow();
        if (webView != null) {
            if (webView.getParent() instanceof ViewGroup) ((ViewGroup) webView.getParent()).removeView(webView);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private final class NexusWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (isNexusOrigin(url)) return false;
            if (request.isForMainFrame() && request.hasGesture()) openExternal(url);
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            resetBridge();
            pageFailed = false;
            if (!isNexusUrl(url)) {
                view.stopLoading();
                showError(R.string.connection_error, true);
            }
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            progressBar.setVisibility(View.GONE);
            if (!pageFailed && isNexusUrl(url) && isNexusUrl(view.getUrl())) {
                trustedDocument = true;
                errorPanel.setVisibility(View.GONE);
                connectBridge();
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) showError(R.string.connection_error, true);
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (request.isForMainFrame() && response.getStatusCode() >= 400) showError(R.string.connection_error, true);
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler sslHandler, SslError error) {
            sslHandler.cancel();
            showError(R.string.connection_error, true);
        }

        @Override
        public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
            resetBridge();
            if (view.getParent() instanceof ViewGroup) ((ViewGroup) view.getParent()).removeView(view);
            view.destroy();
            webView = null;
            showError(R.string.webview_error, false);
            return true;
        }
    }
}
