// dsh-display.cs - DSH 显示器（WebView2 原生宿主）
// 编译见 build.cmd：使用系统自带 .NET Framework csc.exe，无需安装任何 SDK。
// 用法: dsh-display.exe [url] [userDataFolder]

using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

static class DisplayHost
{
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SetCurrentProcessExplicitAppUserModelID(string appId);

    [STAThread]
    private static int Main(string[] args)
    {
        // 任务栏分组与图标归属（独立于 Edge，标准 Win32 机制）
        try { SetCurrentProcessExplicitAppUserModelID("DeepSeekHarness.Shell.Display"); } catch { }

        string url = "http://127.0.0.1:3080";
        string userData = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "dsh-shell", "webview2-display");
        if (args.Length > 0 && !string.IsNullOrWhiteSpace(args[0])) url = args[0];
        if (args.Length > 1 && !string.IsNullOrWhiteSpace(args[1])) userData = args[1];

        Log("start url=" + url);

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new DisplayForm(url, userData));
        return 0;
    }

    public static void Log(string message)
    {
        try
        {
            string dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "dsh-shell");
            Directory.CreateDirectory(dir);
            File.AppendAllText(
                Path.Combine(dir, "display.log"),
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + message + Environment.NewLine);
        }
        catch { }
    }
}

sealed class DisplayForm : Form
{
    private readonly string url;
    private WebView2 web;

    public DisplayForm(string url, string userData)
    {
        this.url = url;

        Text = "DSH 显示器 - DeepSeek Harness";
        StartPosition = FormStartPosition.CenterScreen;
        Size = new Size(1280, 800);
        MinimizeBox = true;
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        web = new WebView2();
        web.Dock = DockStyle.Fill;

        CoreWebView2CreationProperties cp = new CoreWebView2CreationProperties();
        cp.UserDataFolder = userData;
        web.CreationProperties = cp;

        Controls.Add(web);
        Load += OnLoad;
    }

    private async void OnLoad(object sender, EventArgs e)
    {
        try
        {
            await web.EnsureCoreWebView2Async();
            DisplayHost.Log("core created");
            CoreWebView2Settings s = web.CoreWebView2.Settings;
            s.AreDevToolsEnabled = false;
            s.IsStatusBarEnabled = false;
            s.AreDefaultContextMenusEnabled = false;
            web.CoreWebView2.NewWindowRequested += OnNewWindowRequested;
            web.CoreWebView2.Navigate(url);
            DisplayHost.Log("navigate " + url);
        }
        catch (Exception ex)
        {
            DisplayHost.Log("ERR " + ex.Message);
            try
            {
                MessageBox.Show(
                    "WebView2 运行时不可用，已改用默认浏览器打开。"
                    + Environment.NewLine + Environment.NewLine + ex.Message,
                    "DSH 显示器",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
                System.Diagnostics.Process.Start(url);
            }
            catch { }
            Close();
        }
    }

    private void OnNewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        // 新窗口链接改由默认浏览器打开，显示器只负责 dsh 主界面
        e.Handled = true;
        try { System.Diagnostics.Process.Start(e.Uri); } catch { }
    }
}
