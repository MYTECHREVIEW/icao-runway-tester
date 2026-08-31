Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="ICAO Runway Tester - Dev Launcher" Height="500" Width="520"
        WindowStartupLocation="CenterScreen"
        Background="#0E131F" ResizeMode="CanMinimize" FontFamily="Segoe UI">
    <Window.Resources>
        <Style TargetType="Button">
            <Setter Property="Foreground" Value="#FFFFFF"/>
            <Setter Property="FontWeight" Value="SemiBold"/>
            <Setter Property="FontSize" Value="13"/>
            <Setter Property="BorderThickness" Value="0"/>
            <Setter Property="Cursor" Value="Hand"/>
            <Setter Property="Padding" Value="10,8"/>
            <Setter Property="Template">
                <Setter.Value>
                    <ControlTemplate TargetType="Button">
                        <Border x:Name="border" Background="{TemplateBinding Background}" CornerRadius="6" Padding="{TemplateBinding Padding}">
                            <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
                        </Border>
                        <ControlTemplate.Triggers>
                            <Trigger Property="IsMouseOver" Value="True">
                                <Setter Property="Opacity" Value="0.88"/>
                            </Trigger>
                            <Trigger Property="IsEnabled" Value="False">
                                <Setter Property="Opacity" Value="0.35"/>
                                <Setter Property="Cursor" Value="Arrow"/>
                            </Trigger>
                        </ControlTemplate.Triggers>
                    </ControlTemplate>
                </Setter.Value>
            </Setter>
        </Style>
    </Window.Resources>

    <Grid Margin="20">
        <Grid.RowDefinitions>
            <RowDefinition Height="Auto"/>
            <RowDefinition Height="Auto"/>
            <RowDefinition Height="Auto"/>
            <RowDefinition Height="*"/>
            <RowDefinition Height="Auto"/>
        </Grid.RowDefinitions>

        <!-- Header -->
        <StackPanel Grid.Row="0" Margin="0,0,0,15">
            <TextBlock Text="✈️ ICAO Runway Tester" FontSize="20" FontWeight="Bold" Foreground="#60A5FA"/>
            <TextBlock Text="Local Node.js Development Environment Controller" FontSize="11" Foreground="#94A3B8" Margin="0,2,0,0"/>
        </StackPanel>

        <!-- Status Card -->
        <Border Grid.Row="1" Background="#162032" CornerRadius="8" Padding="15" Margin="0,0,0,15" BorderBrush="#1E293B" BorderThickness="1">
            <Grid>
                <Grid.ColumnDefinitions>
                    <ColumnDefinition Width="*"/>
                    <ColumnDefinition Width="Auto"/>
                </Grid.ColumnDefinitions>
                <StackPanel Grid.Column="0">
                    <TextBlock Text="SERVER STATUS" FontSize="10" FontWeight="Bold" Foreground="#64748B"/>
                    <StackPanel Orientation="Horizontal" Margin="0,4,0,0" VerticalAlignment="Center">
                        <Ellipse x:Name="StatusDot" Width="12" Height="12" Fill="#EF4444" Margin="0,0,8,0"/>
                        <TextBlock x:Name="StatusText" Text="OFFLINE" FontSize="15" FontWeight="Bold" Foreground="#EF4444"/>
                    </StackPanel>
                </StackPanel>
                <TextBlock Grid.Column="1" Text="Port 3500" FontSize="12" Foreground="#94A3B8" VerticalAlignment="Center"/>
            </Grid>
        </Border>

        <!-- Controls -->
        <Grid Grid.Row="2" Margin="0,0,0,15">
            <Grid.ColumnDefinitions>
                <ColumnDefinition Width="*"/>
                <ColumnDefinition Width="*"/>
                <ColumnDefinition Width="*"/>
                <ColumnDefinition Width="1.2*"/>
            </Grid.ColumnDefinitions>
            <Button x:Name="BtnStart" Grid.Column="0" Content="▶ Start" Background="#10B981" Margin="0,0,5,0"/>
            <Button x:Name="BtnStop" Grid.Column="1" Content="⏹ Stop" Background="#EF4444" Margin="5,0,5,0" IsEnabled="False"/>
            <Button x:Name="BtnRestart" Grid.Column="2" Content="🔄 Restart" Background="#F59E0B" Margin="5,0,5,0" IsEnabled="False"/>
            <Button x:Name="BtnOpenBrowser" Grid.Column="3" Content="🌐 Open UI" Background="#3B82F6" Margin="5,0,0,0"/>
        </Grid>

        <!-- Activity Log -->
        <Border Grid.Row="3" Background="#0A0E17" CornerRadius="6" BorderBrush="#1E293B" BorderThickness="1">
            <Grid>
                <Grid.RowDefinitions>
                    <RowDefinition Height="Auto"/>
                    <RowDefinition Height="*"/>
                </Grid.RowDefinitions>
                <Border Grid.Row="0" Background="#111827" CornerRadius="6,6,0,0" Padding="10,6">
                    <TextBlock Text="Activity Console" FontSize="11" FontWeight="SemiBold" Foreground="#94A3B8"/>
                </Border>
                <ScrollViewer Grid.Row="1" x:Name="LogScroll" VerticalScrollBarVisibility="Auto" Margin="8">
                    <TextBox x:Name="LogBox" Background="Transparent" Foreground="#CBD5E1" 
                             BorderThickness="0" FontFamily="Consolas" FontSize="11" 
                             IsReadOnly="True" TextWrapping="Wrap"/>
                </ScrollViewer>
            </Grid>
        </Border>

        <!-- Footer -->
        <TextBlock Grid.Row="4" Text="Double-click buttons or close window anytime." FontSize="10" Foreground="#475569" Margin="0,10,0,0" HorizontalAlignment="Center"/>
    </Grid>
</Window>
"@

$reader = [System.Xml.XmlReader]::Create([System.IO.StringReader]::new($xaml))
$window = [System.Windows.Markup.XamlReader]::Load($reader)

# Element References
$statusDot     = $window.FindName("StatusDot")
$statusText    = $window.FindName("StatusText")
$btnStart      = $window.FindName("BtnStart")
$btnStop       = $window.FindName("BtnStop")
$btnRestart    = $window.FindName("BtnRestart")
$btnOpenBrowser= $window.FindName("BtnOpenBrowser")
$logBox        = $window.FindName("LogBox")
$logScroll     = $window.FindName("LogScroll")

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $scriptDir) { $scriptDir = "Z:\icao-runway-tester" }
$port = 3500

function Write-Log([string]$msg) {
    $timestamp = (Get-Date).ToString("HH:mm:ss")
    $logBox.AppendText("[$timestamp] $msg`r`n")
    $logScroll.ScrollToEnd()
}

function Test-ServerRunning {
    try {
        $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        return ($null -ne $conn)
    } catch {
        return $false
    }
}

function Update-UIState {
    $isRunning = Test-ServerRunning
    if ($isRunning) {
        $statusDot.Fill = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#10B981")
        $statusText.Text = "ONLINE (Port $port)"
        $statusText.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#10B981")
        $btnStart.IsEnabled = $false
        $btnStop.IsEnabled = $true
        $btnRestart.IsEnabled = $true
    } else {
        $statusDot.Fill = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#EF4444")
        $statusText.Text = "OFFLINE"
        $statusText.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#EF4444")
        $btnStart.IsEnabled = $true
        $btnStop.IsEnabled = $false
        $btnRestart.IsEnabled = $false
    }
}

function Start-ServerProcess {
    if (Test-ServerRunning) {
        Write-Log "Server is already online on port $port."
        return
    }
    Write-Log "Starting Node.js server..."
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = "cmd.exe"
    $startInfo.Arguments = "/k cd /d `"$scriptDir`" && title ICAO Runway Tester Server && node server.js"
    $startInfo.WorkingDirectory = $scriptDir
    [System.Diagnostics.Process]::Start($startInfo) | Out-Null
    Write-Log "Launch signal sent. Checking status..."
}

function Stop-ServerProcess {
    Write-Log "Stopping server..."
    try {
        $connections = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
        if ($connections) {
            foreach ($c in $connections) {
                if ($c.OwningProcess -gt 0) {
                    Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
                    Write-Log "Terminated process PID: $($c.OwningProcess)"
                }
            }
        }
        # Also clean up CMD window
        $cmdProcs = Get-CimInstance Win32_Process -Filter "Name = 'cmd.exe'" | Where-Object { $_.CommandLine -like "*ICAO Runway Tester Server*" }
        foreach ($p in $cmdProcs) {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        }
    } catch {
        Write-Log "Error terminating process: $($_.Exception.Message)"
    }
    Write-Log "Server stopped."
}

# Button Click Handlers
$btnStart.Add_Click({
    Start-ServerProcess
})

$btnStop.Add_Click({
    Stop-ServerProcess
})

$btnRestart.Add_Click({
    Write-Log "Restarting server..."
    Stop-ServerProcess
    Start-Sleep -Milliseconds 800
    Start-ServerProcess
})

$btnOpenBrowser.Add_Click({
    Write-Log "Opening http://localhost:$port in default browser..."
    Start-Process "http://localhost:$port"
})

# Polling Timer for Real-Time Status
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(1200)
$timer.Add_Tick({
    Update-UIState
})
$timer.Start()

Write-Log "ICAO Runway Tester Launcher ready."
Update-UIState

$window.ShowDialog() | Out-Null
