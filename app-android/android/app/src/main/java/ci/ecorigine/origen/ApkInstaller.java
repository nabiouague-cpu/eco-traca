package ci.ecorigine.origen;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Mise à jour dans l'application : télécharge le nouvel APK (avec progression),
 * puis ouvre l'installateur Android. Android impose toujours une confirmation (un appui sur « Installer »).
 */
@CapacitorPlugin(name = "ApkInstaller")
public class ApkInstaller extends Plugin {
    private static final String PREFIXE = "https://github.com/nabiouague-cpu/eco-traca/releases/";
    private volatile boolean enCours = false;
    private byte[] donnees = null;

    private File fichier() {
        File d = new File(getContext().getCacheDir(), "maj");
        d.mkdirs();
        return new File(d, "ORIGEN-Terrain.apk");
    }

    @PluginMethod
    public void peutInstaller(PluginCall call) {
        boolean ok = Build.VERSION.SDK_INT < 26 || getContext().getPackageManager().canRequestPackageInstalls();
        JSObject r = new JSObject();
        r.put("ok", ok);
        call.resolve(r);
    }

    @PluginMethod
    public void autoriser(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Impossible d'ouvrir les réglages : " + e.getMessage());
        }
    }

    @PluginMethod
    public void telecharger(final PluginCall call) {
        final String url = call.getString("url");
        if (url == null || !url.startsWith(PREFIXE)) {
            call.reject("Adresse de mise à jour non reconnue");
            return;
        }
        if (enCours) {
            call.reject("Un téléchargement est déjà en cours");
            return;
        }
        enCours = true;
        new Thread(new Runnable() {
            @Override
            public void run() {
                HttpURLConnection c = null;
                try {
                    File f = fichier();
                    File tmp = new File(f.getParentFile(), "telechargement.part");
                    c = (HttpURLConnection) new URL(url).openConnection();
                    c.setConnectTimeout(20000);
                    c.setReadTimeout(30000);
                    c.setInstanceFollowRedirects(true);
                    int code = c.getResponseCode();
                    if (code != 200) throw new IOException("Serveur : code " + code);
                    long total = c.getContentLengthLong();
                    long recu = 0, dernier = 0;
                    try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(tmp)) {
                        byte[] buf = new byte[32768];
                        int n;
                        while ((n = in.read(buf)) > 0) {
                            out.write(buf, 0, n);
                            recu += n;
                            long now = System.currentTimeMillis();
                            if (now - dernier > 250) {
                                dernier = now;
                                JSObject p = new JSObject();
                                p.put("recu", recu);
                                p.put("total", total);
                                notifyListeners("progres", p);
                            }
                        }
                    }
                    if (recu < 1000000 || (total > 0 && recu != total)) throw new IOException("Fichier incomplet (" + recu + " octets)");
                    byte[] tete = new byte[2];
                    try (FileInputStream fi = new FileInputStream(tmp)) {
                        if (fi.read(tete) != 2 || tete[0] != 'P' || tete[1] != 'K') throw new IOException("Ce n'est pas un fichier d'application");
                    }
                    if (f.exists()) f.delete();
                    if (!tmp.renameTo(f)) throw new IOException("Fichier non enregistré");
                    JSObject p = new JSObject();
                    p.put("recu", recu);
                    p.put("total", recu);
                    notifyListeners("progres", p);
                    JSObject r = new JSObject();
                    r.put("taille", recu);
                    call.resolve(r);
                } catch (Exception e) {
                    call.reject(e.getMessage() != null ? e.getMessage() : e.toString());
                } finally {
                    enCours = false;
                    if (c != null) c.disconnect();
                }
            }
        }).start();
    }

    @PluginMethod
    public void installer(PluginCall call) {
        File f = fichier();
        if (!f.exists()) {
            call.reject("Fichier introuvable : télécharge-le à nouveau");
            return;
        }
        try {
            Context ctx = getContext();
            Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", f);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Installation impossible : " + e.getMessage());
        }
    }

    /** Enregistre un fichier généré par l'application (Excel, ZIP…) : l'utilisateur choisit le dossier et le nom. */
    @PluginMethod
    public void enregistrer(PluginCall call) {
        String b64 = call.getString("base64");
        String nom = call.getString("nom", "fichier");
        String mime = call.getString("mime", "application/octet-stream");
        if (b64 == null || b64.isEmpty()) {
            call.reject("Fichier vide");
            return;
        }
        try {
            donnees = android.util.Base64.decode(b64, android.util.Base64.DEFAULT);
            Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType(mime);
            i.putExtra(Intent.EXTRA_TITLE, nom);
            startActivityForResult(call, i, "apresEnregistrer");
        } catch (Exception e) {
            donnees = null;
            call.reject("Enregistrement impossible : " + e.getMessage());
        }
    }

    @ActivityCallback
    private void apresEnregistrer(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            donnees = null;
            call.reject("annulé");
            return;
        }
        try {
            OutputStream out = getContext().getContentResolver().openOutputStream(result.getData().getData());
            if (out == null) throw new IOException("Dossier inaccessible");
            try {
                out.write(donnees);
                out.flush();
            } finally {
                out.close();
            }
            JSObject r = new JSObject();
            r.put("ok", true);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Enregistrement impossible : " + e.getMessage());
        } finally {
            donnees = null;
        }
    }
}
