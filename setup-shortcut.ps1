# Create shortcut with icon + AppUserModelID for taskbar separation
param(
  [string]$LnkPath,
  [string]$Target,
  [string]$Arguments,
  [string]$Icon,
  [string]$Aumid
)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class LnkAumid {
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    int GetCount(out uint c);
    int GetAt(uint i, out Guid key);
    int GetValue(ref Guid key, out PropVariant pv);
    int SetValue(ref Guid key, ref PropVariant pv);
    int Commit();
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PropVariant { public ushort vt; public ushort r1; public ushort r2; public ushort r3; public IntPtr p1; public IntPtr p2; }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHGetPropertyStoreFromParsingName(string path, IntPtr pbc, int flags, ref Guid riid, out IPropertyStore ppv);
  public static string Set(string lnkPath, string aumid) {
    Guid pkey = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
    Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
    IPropertyStore store;
    int h1 = SHGetPropertyStoreFromParsingName(lnkPath, IntPtr.Zero, 2, ref iid, out store);
    if (h1 != 0) return "GetStore=" + h1;
    PropVariant pv = new PropVariant();
    pv.vt = 31;
    pv.p1 = Marshal.StringToCoTaskMemUni(aumid);
    int h2 = store.SetValue(ref pkey, ref pv);
    int h3 = store.Commit();
    Marshal.FreeCoTaskMem(pv.p1);
    PropVariant rp;
    int h4 = store.GetValue(ref pkey, out rp);
    string back = (rp.vt == 31) ? Marshal.PtrToStringUni(rp.p1) : ("vt=" + rp.vt);
    return "h1=" + h1 + " h2=" + h2 + " h3=" + h3 + " h4=" + h4 + " back=[" + back + "]";
  }
}
"@
$ws = New-Object -ComObject WScript.Shell
$dir = Split-Path -Parent $LnkPath
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$lnk = $ws.CreateShortcut($LnkPath)
$lnk.TargetPath = $Target
$lnk.Arguments = $Arguments
$lnk.IconLocation = $Icon
$lnk.WorkingDirectory = (Split-Path -Parent $Target)
$lnk.Save()
Write-Output ("AUMID_SET: " + [LnkAumid]::Set($LnkPath, $Aumid))
