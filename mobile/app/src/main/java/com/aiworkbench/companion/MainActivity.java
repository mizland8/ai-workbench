package com.aiworkbench.companion;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.widget.*;
import org.json.*;
import java.text.DateFormat;
import java.util.*;
import java.util.concurrent.*;

/** Offline-first native companion. No remote delivery exists until a PC is paired. */
@android.annotation.SuppressLint("SetTextI18n") // English preview UI; localization is not yet provided.
public class MainActivity extends Activity {
    private final int BG=Color.rgb(16,20,20), CARD=Color.rgb(26,32,31), LINE=Color.rgb(49,60,55),
        INK=Color.rgb(239,245,239), MUTED=Color.rgb(156,172,164), GREEN=Color.rgb(165,243,194);
    private SharedPreferences prefs;
    private JSONArray pcs=new JSONArray(), drafts=new JSONArray();
    private LinearLayout root, content, nav;
    private String tab="Overview";
    private boolean draftFilter=false;
    private LinkClient links;
    private final ExecutorService network=Executors.newCachedThreadPool();
    private final Map<String,JSONObject> snapshots=new HashMap<>();
    private final Map<String,String> connectionStates=new HashMap<>();
    private volatile int watchGeneration=0;
    private String selectedPc=null,selectedChat=null,selectedProject=null;
    private TextView liveOutput,liveStatus,liveReceipt;
    private String lastMessageId;
    private EditText messageInput;
    private JSONObject retryMessage;
    private int dialogs=0;
    @Override protected void onStart(){super.onStart();startWatches();}
    @Override protected void onStop(){watchGeneration++;super.onStop();}
    @Override protected void onDestroy(){network.shutdownNow();super.onDestroy();}
    private void startWatches(){
        int generation=++watchGeneration;
        for(int i=0;i<pcs.length();i++){
            String id=pcs.optJSONObject(i).optString("id");if(!links.linked(id))continue;
            network.execute(()->{Long revision=null;
                while(generation==watchGeneration&&!Thread.currentThread().isInterrupted()){
                    try{JSONObject descriptor=links.load(id);if(descriptor==null)return;
                        JSONObject response=links.request(descriptor,revision==null?"snapshot":"snapshot?since="+revision,null);revision=response.getLong("revision");JSONObject snapshot=response.optJSONObject("snapshot");
                        runOnUiThread(()->{if(generation!=watchGeneration)return;if(snapshot!=null)snapshots.put(id,snapshot);connectionStates.put(id,"Connected");
                            if(selectedChat!=null){refreshLiveChat();}else if(dialogs==0){render();}});
                    }catch(Exception e){runOnUiThread(()->{if(generation!=watchGeneration)return;connectionStates.put(id,"Offline · "+e.getMessage());if(selectedChat!=null)refreshLiveChat();else if(dialogs==0)render();});
                        try{Thread.sleep(5000);}catch(InterruptedException stop){Thread.currentThread().interrupt();return;}
                    }
                }
            });
        }
    }
    private String connection(String id){return connectionStates.getOrDefault(id,links.linked(id)?"Connecting…":"Not linked");}
    private int linkedCount(){int count=0;for(int i=0;i<pcs.length();i++)if(links.linked(pcs.optJSONObject(i).optString("id")))count++;return count;}


    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        links=new LinkClient(this);
        prefs=getSharedPreferences("workbench", MODE_PRIVATE);
        try { pcs=new JSONArray(prefs.getString("pcs","[]")); drafts=new JSONArray(prefs.getString("drafts","[]")); }
        catch(JSONException e) { Toast.makeText(this,"Saved data could not be read.",Toast.LENGTH_LONG).show(); }
        if(!prefs.contains("pcs")) {
            for(int i=1;i<=3;i++) pcs.put(object("id",UUID.randomUUID().toString(),"name","PC "+i,"note",""));
            save();
        }
        if(state!=null) {tab=state.getString("tab","Overview"); draftFilter=state.getBoolean("draftFilter",false);selectedPc=state.getString("selectedPc");selectedChat=state.getString("selectedChat");selectedProject=state.getString("selectedProject");}
        render();
    }
    @Override protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out); out.putString("tab",tab); out.putBoolean("draftFilter",draftFilter);out.putString("selectedPc",selectedPc);out.putString("selectedChat",selectedChat);out.putString("selectedProject",selectedProject);
    }
    private JSONObject object(String... pairs) {
        JSONObject o=new JSONObject();
        for(int i=0;i<pairs.length;i+=2) try{o.put(pairs[i],pairs[i+1]);}catch(JSONException ignored){}
        return o;
    }
    private void save(){ prefs.edit().putString("pcs",pcs.toString()).putString("drafts",drafts.toString()).apply(); }
    private int dp(float n){return (int)(n*getResources().getDisplayMetrics().density+.5f);}
    private GradientDrawable shape(int color,int stroke,int radius){
        GradientDrawable d=new GradientDrawable();d.setColor(color);d.setCornerRadius(dp(radius));
        if(stroke!=0)d.setStroke(dp(1),stroke);return d;
    }
    private TextView text(String value,int size,int color,boolean bold){
        TextView t=new TextView(this);t.setText(value);t.setTextSize(size);t.setTextColor(color);
        t.setFontFeatureSettings("kern");t.setLineSpacing(dp(3),1);
        if(bold)t.setTypeface(Typeface.create("sans-serif-medium",Typeface.NORMAL));return t;
    }
    private LinearLayout vertical(){LinearLayout l=new LinearLayout(this);l.setOrientation(LinearLayout.VERTICAL);return l;}
    private void space(LinearLayout p,int h){View v=new View(this);p.addView(v,new LinearLayout.LayoutParams(1,dp(h)));}
    private LinearLayout card(){
        LinearLayout c=vertical();c.setPadding(dp(20),dp(20),dp(20),dp(20));c.setBackground(shape(CARD,LINE,20));
        LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(-1,-2);lp.bottomMargin=dp(12);content.addView(c,lp);return c;
    }
    private TextView action(LinearLayout parent,String label,boolean primary,Runnable click){
        TextView b=text(label,14,primary?BG:GREEN,true);b.setGravity(Gravity.CENTER);
        b.setPadding(dp(14),dp(14),dp(14),dp(14));b.setBackground(shape(primary?GREEN:CARD,primary?0:LINE,12));
        LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(-1,-2);lp.topMargin=dp(12);parent.addView(b,lp);
        b.setOnClickListener(v->click.run());return b;
    }
    private void heading(String eyebrow,String title,String desc){
        content.addView(text(eyebrow.toUpperCase(Locale.ROOT),11,GREEN,true));space(content,8);
        content.addView(text(title,32,INK,true));space(content,8);content.addView(text(desc,14,MUTED,false));space(content,24);
    }
    private void section(String name){space(content,10);content.addView(text(name,18,INK,true));space(content,12);}
    private String pcName(String id){for(int i=0;i<pcs.length();i++)if(pcs.optJSONObject(i).optString("id").equals(id))return pcs.optJSONObject(i).optString("name");return "Removed computer";}

    private void render(){
        root=vertical();root.setBackgroundColor(BG);setContentView(root);
        root.setOnApplyWindowInsetsListener((v,insets)->{
            android.graphics.Insets bars=insets.getInsets(WindowInsets.Type.systemBars()|WindowInsets.Type.displayCutout()|WindowInsets.Type.ime());
            v.setPadding(bars.left,bars.top,bars.right,bars.bottom);return insets;
        });root.requestApplyInsets();
        LinearLayout top=new LinearLayout(this);top.setGravity(Gravity.CENTER_VERTICAL);top.setPadding(dp(22),dp(12),dp(16),dp(12));
        TextView brand=text("W /  WORKBENCH",14,INK,true);top.addView(brand,new LinearLayout.LayoutParams(0,-2,1));
        TextView info=text("About",13,MUTED,false);info.setPadding(dp(14),dp(10),dp(14),dp(10));info.setOnClickListener(v->about());top.addView(info);root.addView(top);
        ScrollView scroll=new ScrollView(this);scroll.setFillViewport(true);scroll.setClipToPadding(false);
        content=vertical();content.setPadding(dp(22),dp(14),dp(22),dp(24));scroll.addView(content);
        root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
        if(selectedChat!=null){liveChat();}else switch(tab){case "Computers":computers();break;case "Projects":projects();break;case "Chats":chats();break;default:overview();}
        nav=new LinearLayout(this);nav.setPadding(dp(8),dp(8),dp(8),dp(8));nav.setBackground(shape(BG,LINE,0));
        String[] tabs={"Overview","Computers","Projects","Chats"};String[] icons={"◉","▣","▤","☰"};
        for(int i=0;i<tabs.length;i++){
            String name=tabs[i];TextView item=text(icons[i]+"\n"+name,11,name.equals(tab)?GREEN:MUTED,true);item.setGravity(Gravity.CENTER);item.setMinHeight(dp(58));
            if(name.equals(tab))item.setBackground(shape(CARD,0,14));
            item.setOnClickListener(v->{tab=name;selectedChat=null;selectedPc=null;selectedProject=null;draftFilter=false;render();});nav.addView(item,new LinearLayout.LayoutParams(0,-2,1));
        }root.addView(nav);
    }
    private void overview(){
        heading("Your workspace, anywhere","Stay in the loop.","Your computers. Your AI teammates. One place to pick up where you left off.");
        LinearLayout status=card();status.addView(text("COMPANION / EARLY ACCESS",11,GREEN,true));space(status,12);
        status.addView(text("Ready for your computers",22,INK,true));space(status,8);
        status.addView(text("Pair your PCs to see AI usage, read their chats, and send work from your phone.",14,MUTED,false));
        action(status,"Set up computers  →",true,()->{tab="Computers";render();});
        LinearLayout counts=card();counts.addView(text(pcs.length()+" computers saved  ·  "+linkedCount()+" linked",17,INK,true));space(counts,8);
        counts.addView(text(linkedCount()==0?"Pair a computer to see its activity.":"Open Computers to check each connection.",13,MUTED,false));
        section("AI usage");
        for(Map.Entry<String,JSONObject> entry:snapshots.entrySet()){
            JSONObject report=entry.getValue().optJSONObject("usage");if(report==null)continue;
            JSONArray tools=report.optJSONArray("tools");if(tools==null)continue;
            for(int i=0;i<tools.length();i++){JSONObject tool=tools.optJSONObject(i);LinearLayout c=card();c.addView(text(pcName(entry.getKey())+" / "+tool.optString("id"),16,INK,true));
                JSONArray limits=tool.optJSONArray("limits");if(limits==null||limits.length()==0)c.addView(text("No allowance data reported",13,MUTED,false));
                else for(int j=0;j<limits.length();j++){JSONObject limit=limits.optJSONObject(j);space(c,8);c.addView(text(limit.optString("label")+" · "+Math.round(limit.optDouble("usedPercent"))+"% used",14,GREEN,false));}
                c.addView(text(connection(entry.getKey())+" · updated "+new Date(report.optLong("generatedAt")).toString(),11,MUTED,false));
            }
        }
        if(snapshots.isEmpty())for(String tool:new String[]{"Claude","Codex","Other agents"}){
            LinearLayout c=card();c.addView(text(tool,16,INK,true));space(c,6);c.addView(text("—   Awaiting a linked PC",14,MUTED,false));
        }
        section("Pick up a thought");LinearLayout c=card();c.addView(text(drafts.length()+" saved message drafts",18,INK,true));space(c,6);
        c.addView(text("Write instructions now and keep them on this phone. Drafts are never sent automatically.",14,MUTED,false));
        action(c,"Write a draft",true,()->editDraft(null));
        if(drafts.length()>0)action(c,"View drafts",false,()->{tab="Chats";draftFilter=true;render();});
    }
    private void computers(){
        heading("Your fleet","Computers","Pair each PC using its Computers & phone menu in AI Workbench.");
        for(int i=0;i<pcs.length();i++){
            JSONObject pc=pcs.optJSONObject(i);LinearLayout c=card();c.addView(text("▣  "+pc.optString("name"),21,INK,true));space(c,8);
            c.addView(text("○  "+connection(pc.optString("id")),13,MUTED,true));space(c,8);
            c.addView(text(pc.optString("note").isEmpty()?"Add a note to identify this computer.":pc.optString("note"),14,MUTED,false));
            action(c,"Edit computer",false,()->editPc(pc));
            if(!links.linked(pc.optString("id")))action(c,"Link computer",true,()->pairPc(pc));
            else{action(c,"Browse chats",true,()->{selectedPc=pc.optString("id");selectedProject=null;tab="Chats";draftFilter=false;render();});
                action(c,"Unlink on this phone",false,()->new AlertDialog.Builder(this).setTitle("Unlink computer?").setMessage("Also revoke this phone in the PC’s Computers menu if you want to invalidate its credential.").setNegativeButton("Cancel",null).setPositiveButton("Unlink",(a,w)->{String id=pc.optString("id");links.forget(id);snapshots.remove(id);connectionStates.remove(id);startWatches();render();}).show());}
        }
        action(content,"+ Add computer",true,()->editPc(null));
        section("Connection");content.addView(text("Keep Workbench open on each PC. Use the same Wi-Fi or a private network. Pairing codes expire after five minutes. Each PC can revoke this phone independently.",14,MUTED,false));
    }
    private void projects(){
        heading("Across your computers","Projects","Projects from your linked computers.");
        boolean any=false;
        for(Map.Entry<String,JSONObject> entry:snapshots.entrySet()){
            JSONArray projects=entry.getValue().optJSONArray("projects");if(projects==null)continue;
            for(int i=0;i<projects.length();i++){any=true;JSONObject project=projects.optJSONObject(i);LinearLayout row=card();row.addView(text(project.optString("name"),20,INK,true));row.addView(text(pcName(entry.getKey())+" · "+connection(entry.getKey()),13,MUTED,false));
                action(row,"View chats",false,()->{selectedPc=entry.getKey();selectedProject=project.optString("id");tab="Chats";draftFilter=false;render();});}
        }
        if(any)return;
        LinearLayout c=card();c.addView(text("▤",36,GREEN,true));space(c,14);c.addView(text("No synced projects yet",22,INK,true));space(c,8);
        c.addView(text("Projects belong to a computer. Link one to browse its folders and AI chats from your phone.",14,MUTED,false));
        action(c,"View computers",true,()->{tab="Computers";render();});
        section("Plan your next task");content.addView(text("You can save a message draft with a project and chat name while linking is being built.",14,MUTED,false));
        action(content,"Write a draft",false,()->editDraft(null));
    }
    private void chats(){
        heading("Conversations","Chats & drafts","Read your AI chats, send work, and keep local drafts.");
        LinearLayout filters=new LinearLayout(this);
        for(String label:new String[]{"Live chats","Drafts ("+drafts.length()+")"}){
            boolean isDraft=label.startsWith("Drafts");TextView b=text(label,14,isDraft==draftFilter?BG:MUTED,true);b.setGravity(Gravity.CENTER);b.setPadding(dp(14),dp(12),dp(14),dp(12));b.setBackground(shape(isDraft==draftFilter?GREEN:CARD,0,12));
            LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(0,-2,1);p.setMargins(0,0,dp(6),dp(16));filters.addView(b,p);b.setOnClickListener(v->{draftFilter=isDraft;render();});
        }content.addView(filters);
        if(!draftFilter){
            boolean any=false;
            for(Map.Entry<String,JSONObject> entry:snapshots.entrySet()){
                if(selectedPc!=null&&!selectedPc.equals(entry.getKey()))continue;
                JSONArray chats=entry.getValue().optJSONArray("chats");if(chats==null)continue;
                for(int i=0;i<chats.length();i++){any=true;JSONObject chat=chats.optJSONObject(i);if(selectedProject!=null&&!selectedProject.equals(chat.optString("projectId")))continue;LinearLayout row=card();row.addView(text(chat.optString("name"),20,INK,true));space(row,6);row.addView(text(pcName(entry.getKey())+" / "+chat.optString("tool")+" · "+chat.optString("status"),13,MUTED,false));action(row,"Open chat",true,()->{selectedPc=entry.getKey();selectedChat=chat.optString("id");retryMessage=null;render();});}
            }
            if(any){action(content,"Show all computers",false,()->{selectedPc=null;selectedProject=null;render();});return;}
            LinearLayout c=card();c.addView(text("No live chats",22,INK,true));space(c,8);c.addView(text("Link a computer to view its chats and send work. Busy agents receive messages when they are ready.",14,MUTED,false));action(c,"View computers",true,()->{tab="Computers";render();});}
        else if(drafts.length()==0){LinearLayout c=card();c.addView(text("A place for your next idea",20,INK,true));space(c,8);c.addView(text("Save a task now. It stays on your phone until you choose what to do with it.",14,MUTED,false));}
        else for(int i=drafts.length()-1;i>=0;i--){
            JSONObject d=drafts.optJSONObject(i);LinearLayout c=card();
            c.addView(text("DRAFT · NOT SENT",10,GREEN,true));space(c,8);
            c.addView(text(pcName(d.optString("pcId"))+" / "+d.optString("chat","Unassigned chat"),16,INK,true));space(c,6);
            if(!d.optString("project").isEmpty()){c.addView(text(d.optString("project"),12,MUTED,false));space(c,6);}
            TextView body=text(d.optString("body"),15,INK,false);body.setMaxLines(5);c.addView(body);space(c,8);
            c.addView(text(DateFormat.getDateTimeInstance(DateFormat.SHORT,DateFormat.SHORT).format(new Date(d.optLong("updated"))),11,MUTED,false));
            action(c,"Open draft",false,()->editDraft(d));
        }
        action(content,"+ Write a draft",true,()->editDraft(null));
    }
    private EditText input(LinearLayout box,String label,String value,boolean multiline){
        space(box,12);box.addView(text(label,12,MUTED,true));EditText e=new EditText(this);e.setText(value);e.setTextColor(INK);e.setTextSize(16);e.setPadding(dp(12),dp(10),dp(12),dp(10));e.setBackground(shape(BG,LINE,8));
        e.setInputType(InputType.TYPE_CLASS_TEXT | (multiline?InputType.TYPE_TEXT_FLAG_MULTI_LINE|InputType.TYPE_TEXT_FLAG_CAP_SENTENCES:InputType.TYPE_TEXT_FLAG_CAP_SENTENCES));
        if(multiline){e.setMinLines(4);e.setGravity(Gravity.TOP);}else e.setSingleLine(true);
        LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(-1,-2);lp.topMargin=dp(6);box.addView(e,lp);return e;
    }
    private LinearLayout dialogBox(){LinearLayout box=vertical();box.setPadding(dp(22),dp(8),dp(22),dp(8));return box;}
    private void editPc(JSONObject existing){
        LinearLayout box=dialogBox();EditText name=input(box,"Computer name",existing==null?"":existing.optString("name"),false);
        EditText note=input(box,"Note (optional)",existing==null?"":existing.optString("note"),true);
        AlertDialog.Builder b=new AlertDialog.Builder(this).setTitle(existing==null?"Add computer":"Edit computer").setView(box).setNegativeButton("Cancel",null).setPositiveButton("Save",null);
        if(existing!=null)b.setNeutralButton("Remove",(a,w)->confirmRemovePc(existing));
        AlertDialog dialog=b.create();dialog.setOnShowListener(a->dialog.getButton(-1).setOnClickListener(v->{
            String n=name.getText().toString().trim();if(n.isEmpty()){name.setError("Enter a computer name");return;}
            JSONObject pc=existing==null?object("id",UUID.randomUUID().toString()):existing;
            try{pc.put("name",n);pc.put("note",note.getText().toString().trim());}catch(JSONException ignored){}
            if(existing==null)pcs.put(pc);save();dialog.dismiss();render();
        }));dialog.show();
    }
    private void confirmRemovePc(JSONObject pc){
        new AlertDialog.Builder(this).setTitle("Remove "+pc.optString("name")+"?").setMessage("Saved drafts will be kept. This removes only this phone’s computer entry.")
        .setNegativeButton("Cancel",null).setPositiveButton("Remove",(a,w)->{
            for(int i=pcs.length()-1;i>=0;i--)if(pcs.optJSONObject(i).optString("id").equals(pc.optString("id")))pcs.remove(i);
            String removed=pc.optString("id");links.forget(removed);snapshots.remove(removed);connectionStates.remove(removed);startWatches();
            save();render();
        }).show();
    }
    private void editDraft(JSONObject existing){
        if(pcs.length()==0){new AlertDialog.Builder(this).setTitle("Add a computer first").setMessage("Save a computer name so your draft has a destination.").setPositiveButton("Add computer",(a,w)->editPc(null)).setNegativeButton("Cancel",null).show();return;}
        LinearLayout box=dialogBox();box.addView(text("Saved on this phone · drafts are never sent automatically",12,GREEN,false));space(box,12);
        Spinner computer=new Spinner(this);ArrayList<String> names=new ArrayList<>();int selected=0;
        for(int i=0;i<pcs.length();i++){JSONObject p=pcs.optJSONObject(i);names.add(p.optString("name"));if(existing!=null&&p.optString("id").equals(existing.optString("pcId")))selected=i;}
        computer.setAdapter(new ArrayAdapter<>(this,android.R.layout.simple_spinner_dropdown_item,names));computer.setSelection(selected);box.addView(computer);
        EditText project=input(box,"Project (optional)",existing==null?"":existing.optString("project"),false);
        EditText chat=input(box,"Chat / AI name",existing==null?"":existing.optString("chat"),false);
        EditText body=input(box,"Instructions",existing==null?"":existing.optString("body"),true);
        ScrollView scroll=new ScrollView(this);scroll.addView(box);
        AlertDialog.Builder b=new AlertDialog.Builder(this).setTitle(existing==null?"New draft":"Edit draft").setView(scroll).setNegativeButton("Cancel",null).setPositiveButton("Save draft",null);
        if(existing!=null)b.setNeutralButton("Delete",(a,w)->new AlertDialog.Builder(this).setTitle("Delete draft?").setMessage("This cannot be undone.").setNegativeButton("Cancel",null).setPositiveButton("Delete",(x,y)->{
            for(int i=drafts.length()-1;i>=0;i--)if(drafts.optJSONObject(i).optString("id").equals(existing.optString("id")))drafts.remove(i);save();render();
        }).show());
        AlertDialog dialog=b.create();dialog.setOnShowListener(a->dialog.getButton(-1).setOnClickListener(v->{
            String message=body.getText().toString().trim(),recipient=chat.getText().toString().trim();
            if(recipient.isEmpty()){chat.setError("Enter the chat or AI name");return;}if(message.isEmpty()){body.setError("Write your instructions");return;}
            JSONObject d=existing==null?object("id",UUID.randomUUID().toString()):existing;
            try{d.put("pcId",pcs.optJSONObject(computer.getSelectedItemPosition()).optString("id"));d.put("project",project.getText().toString().trim());d.put("chat",recipient);d.put("body",message);d.put("updated",System.currentTimeMillis());}catch(JSONException ignored){}
            if(existing==null)drafts.put(d);save();dialog.dismiss();tab="Chats";draftFilter=true;render();Toast.makeText(this,"Draft saved · not sent",Toast.LENGTH_SHORT).show();
        }));dialog.show();
    }
    private void pairPc(JSONObject pc){
        LinearLayout box=dialogBox();box.addView(text("On the PC: Computers → Enable linking → enter its IP address → Create pairing code. Paste the complete code below.",14,MUTED,false));
        EditText code=input(box,"Pairing code","",true);code.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_FLAG_MULTI_LINE|InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        AlertDialog dialog=new AlertDialog.Builder(this).setTitle("Link "+pc.optString("name")).setView(box).setNegativeButton("Cancel",null).setPositiveButton("Pair",null).create();
        dialogs++;dialog.setOnDismissListener(d->dialogs--);
        dialog.setOnShowListener(d->dialog.getButton(-1).setOnClickListener(v->{String value=code.getText().toString().trim();dialog.getButton(-1).setEnabled(false);
            network.execute(()->{try{JSONObject descriptor=links.pair(value,"Pixel / Workbench Companion");links.save(pc.optString("id"),descriptor);runOnUiThread(()->{dialog.dismiss();startWatches();render();});}
            catch(Exception e){runOnUiThread(()->{code.setError(e.getMessage());dialog.getButton(-1).setEnabled(true);});}});
        }));dialog.show();
    }
    private JSONObject currentChat(){JSONObject snapshot=snapshots.get(selectedPc);JSONArray chats=snapshot==null?null:snapshot.optJSONArray("chats");if(chats!=null)for(int i=0;i<chats.length();i++)if(chats.optJSONObject(i).optString("id").equals(selectedChat))return chats.optJSONObject(i);return null;}
    private void refreshLiveChat(){
        if(liveOutput==null)return;JSONObject chat=currentChat();liveOutput.setText(chat==null?"Waiting for chat output…":chat.optString("output","No output yet"));
        if(liveStatus!=null)liveStatus.setText(connection(selectedPc)+(chat==null?"":" · "+chat.optString("status")));
        JSONObject snapshot=snapshots.get(selectedPc);JSONArray receipts=snapshot==null?null:snapshot.optJSONArray("receipts");
        if(receipts!=null&&liveReceipt!=null&&lastMessageId!=null)for(int i=0;i<receipts.length();i++){JSONObject r=receipts.optJSONObject(i);if(lastMessageId.equals(r.optString("id")))liveReceipt.setText("Receipt: "+r.optString("status")+" · "+lastMessageId);}
    }
    private void liveChat(){
        JSONObject chat=currentChat();heading(pcName(selectedPc),chat==null?"AI chat":chat.optString("name"),"Read the latest terminal output and send work to this chat.");
        liveStatus=text(connection(selectedPc),13,GREEN,true);content.addView(liveStatus);space(content,12);
        LinearLayout output=card();liveOutput=text("",12,INK,false);liveOutput.setTypeface(Typeface.MONOSPACE);liveOutput.setTextIsSelectable(true);output.addView(liveOutput);refreshLiveChat();
        String outgoingKey="outgoing."+selectedPc+"."+selectedChat;
        try{String saved=prefs.getString(outgoingKey,null);retryMessage=saved==null?null:new JSONObject(saved);}catch(JSONException e){retryMessage=null;}
        messageInput=input(content,"Message",retryMessage==null?"":retryMessage.optString("text"),true);
        TextView receipt=text("Messages wait while the AI is busy or needs your approval.",13,MUTED,false);content.addView(receipt);liveReceipt=receipt;
        TextView send=action(content,"Send work",true,()->{});
        send.setOnClickListener(v->{String message=messageInput.getText().toString().trim();if(message.isEmpty()){messageInput.setError("Write instructions first");return;}
            try{if(retryMessage==null||!message.equals(retryMessage.optString("text")))retryMessage=new JSONObject().put("id",UUID.randomUUID().toString()).put("chatId",selectedChat).put("text",message);}
            catch(JSONException ignored){return;}
            JSONObject request=retryMessage;lastMessageId=request.optString("id");
            if(!prefs.edit().putString(outgoingKey,request.toString()).commit()){receipt.setText("Could not save message retry state; nothing sent.");return;}
            String pcId=selectedPc;send.setEnabled(false);receipt.setText("Sending…");
            network.execute(()->{try{JSONObject descriptor=links.load(pcId);if(descriptor==null)throw new Exception("Pair this computer first");JSONObject result=links.request(descriptor,"message",request);
                runOnUiThread(()->{receipt.setText("Receipt: "+result.optString("status")+" · "+result.optString("id"));messageInput.setText("");retryMessage=null;prefs.edit().remove(outgoingKey).apply();send.setEnabled(true);});}
                catch(Exception e){runOnUiThread(()->{receipt.setText(e.getMessage()+". Retry keeps the same message ID.");send.setEnabled(true);});}
            });
        });
        action(content,"Back to chats",false,()->{selectedChat=null;render();});
    }
    private void about(){new AlertDialog.Builder(this).setTitle("Workbench Companion 0.2.0").setMessage("Pair with AI Workbench to view projects, chats, and available usage, and send queued messages. Connections use HTTPS pinned to the PC certificate. Pairing credentials are encrypted with Android Keystore.\n\nKeep the PC awake and Workbench open. Local drafts never send automatically. Usage depends on what each AI reports.").setPositiveButton("Got it",null).show();}
}
