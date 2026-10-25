package com.aiworkbench.companion;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.*;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;
import javax.net.ssl.*;
import java.net.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.cert.*;
import java.util.Arrays;

/** HTTPS client with exact server certificate pinning and Keystore-encrypted credentials. */
final class LinkClient {
    private final Context context;
    LinkClient(Context context){this.context=context;}
    private byte[] unhex(String s)throws Exception{
        if(s.length()%2!=0||!s.matches("[a-fA-F0-9]+"))throw new IOException("Invalid pairing certificate");
        byte[] b=new byte[s.length()/2];for(int i=0;i<b.length;i++)b[i]=(byte)Integer.parseInt(s.substring(i*2,i*2+2),16);return b;
    }
    @android.annotation.SuppressLint("CustomX509TrustManager") // Exact leaf certificate pinning replaces public-CA trust for paired PCs.
    JSONObject request(JSONObject pc,String endpoint,JSONObject body)throws Exception{
        String host=pc.getString("host");int port=pc.getInt("port");
        if(!host.matches("[a-zA-Z0-9.-]+")||port<1||port>65535)throw new IOException("Invalid computer address");
        byte[] expected=unhex(pc.getString("cert"));
        X509TrustManager trust=new X509TrustManager(){
            public X509Certificate[] getAcceptedIssuers(){return new X509Certificate[0];}
            public void checkClientTrusted(X509Certificate[] chain,String auth)throws CertificateException{throw new CertificateException("Client certificates unsupported");}
            public void checkServerTrusted(X509Certificate[] chain,String auth)throws CertificateException{
                if(chain.length==0||!MessageDigest.isEqual(expected,chain[0].getEncoded()))throw new CertificateException("Computer certificate changed. Pair again on the PC.");
                chain[0].checkValidity();
            }
        };
        SSLContext ssl=SSLContext.getInstance("TLS");ssl.init(null,new TrustManager[]{trust},new SecureRandom());
        HttpsURLConnection c=(HttpsURLConnection)new URL("https",host,port,"/"+endpoint).openConnection(Proxy.NO_PROXY);
        c.setSSLSocketFactory(ssl.getSocketFactory());
        // Identity is verified against the exact certificate above; local addresses need not match its SAN.
        c.setHostnameVerifier((hostname,session)->true);c.setInstanceFollowRedirects(false);
        c.setConnectTimeout(8000);c.setReadTimeout(30000);c.setRequestProperty("Accept","application/json");
        if(pc.has("token"))c.setRequestProperty("Authorization","Bearer "+pc.getString("token"));
        try{
            if(body!=null){c.setRequestMethod("POST");c.setDoOutput(true);c.setRequestProperty("Content-Type","application/json");byte[] payload=body.toString().getBytes(StandardCharsets.UTF_8);c.setFixedLengthStreamingMode(payload.length);try(OutputStream out=c.getOutputStream()){out.write(payload);}}
            int status=c.getResponseCode();InputStream stream=status>=400?c.getErrorStream():c.getInputStream();
            if(stream==null)throw new IOException("Computer returned HTTP "+status);
            ByteArrayOutputStream bytes=new ByteArrayOutputStream();try(InputStream in=stream){byte[] buffer=new byte[8192];int n;while((n=in.read(buffer))!=-1){if(bytes.size()+n>8*1024*1024)throw new IOException("Snapshot too large");bytes.write(buffer,0,n);}}
            JSONObject result=new JSONObject(bytes.toString("UTF-8"));if(status<200||status>=300)throw new IOException(result.optString("error","Computer returned HTTP "+status));return result;
        }finally{c.disconnect();}
    }
    JSONObject pair(String code,String name)throws Exception{
        JSONObject descriptor=new JSONObject(code);JSONObject result=request(descriptor,"pair",new JSONObject().put("code",descriptor.getString("code")).put("name",name));
        descriptor.remove("code");descriptor.remove("expiresIn");descriptor.put("token",result.getString("token"));descriptor.put("computerId",result.getString("computerId"));return descriptor;
    }
    private SecretKey key()throws Exception{
        KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);
        if(!store.containsAlias("workbench-links")){
            KeyGenerator generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder("workbench-links",KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());generator.generateKey();
        }return (SecretKey)store.getKey("workbench-links",null);
    }
    void save(String id,JSONObject descriptor)throws Exception{
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key());
        byte[] encrypted=cipher.doFinal(descriptor.toString().getBytes(StandardCharsets.UTF_8)),iv=cipher.getIV();
        byte[] value=new byte[1+iv.length+encrypted.length];value[0]=(byte)iv.length;System.arraycopy(iv,0,value,1,iv.length);System.arraycopy(encrypted,0,value,1+iv.length,encrypted.length);
        if(!context.getSharedPreferences("links",0).edit().putString(id,Base64.encodeToString(value,Base64.NO_WRAP)).commit())throw new IOException("Could not save pairing");
    }
    JSONObject load(String id)throws Exception{
        String stored=context.getSharedPreferences("links",0).getString(id,null);if(stored==null)return null;
        byte[] value=Base64.decode(stored,Base64.NO_WRAP);int len=value[0]&255;if(len<12||len>16||value.length<=len+1)throw new IOException("Pairing data is damaged");
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Arrays.copyOfRange(value,1,len+1)));
        return new JSONObject(new String(cipher.doFinal(Arrays.copyOfRange(value,len+1,value.length)),StandardCharsets.UTF_8));
    }
    boolean linked(String id){return context.getSharedPreferences("links",0).contains(id);}
    void forget(String id){context.getSharedPreferences("links",0).edit().remove(id).apply();}
}
