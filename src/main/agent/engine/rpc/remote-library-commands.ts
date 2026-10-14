import { shellQuote as q } from '../../wrappers/remote-ssh-session'
import { REMOTE_LIBRARY_MAX_INDEX_BYTES } from './remote-library-types'

/** Domain preflight/read uses one no-follow fd; pure SSH fs.readRange may span renamed files. */
export function libraryCommand(
  root: string,
  mode: 'read' | 'prepare' | 'projection' | 'remove',
  key = ''
): string {
  const source = `use strict; use warnings;
use Cwd qw(abs_path); use Fcntl qw(O_RDONLY O_NOFOLLOW O_NONBLOCK S_IFMT S_IFREG S_IFDIR); use Errno qw(ENOENT EEXIST); use JSON::PP; use MIME::Base64 qw(encode_base64); use Digest::SHA qw(sha256_hex);
my ($root, $mode, $key) = @ARGV; my $write = $mode ne 'read'; umask 077;
sub fail { die "PHI_LIBRARY:$_[0]\\n"; }
abs_path($root) eq $root or fail('PATH_INVALID');
sub dir {
  my ($path, $create) = @_; my @s = lstat($path);
  if (!@s) { $!{ENOENT} or fail('PERMISSION_DENIED'); return 0 unless $create; if (!mkdir($path, 0700)) { $!{EEXIST} or fail('STORAGE_FAILED'); } @s = lstat($path); }
  @s && (($s[2] & S_IFMT) == S_IFDIR) && abs_path($path) eq $path or fail('PATH_INVALID');
  $s[4] == $< && !($s[2] & 0022) && ($s[2] & 0500) == 0500 or fail('PERMISSION_DENIED');
  (!$create || ($s[2] & 0200)) or fail('PERMISSION_DENIED'); return 1;
}
sub file {
  my ($path, $limit, $writable) = @_; my @s = lstat($path);
  if (!@s) { $!{ENOENT} or fail('PERMISSION_DENIED'); return undef; }
  (($s[2] & S_IFMT) == S_IFREG) && $s[3] == 1 or fail('FILE_INVALID');
  $s[4] == $< && !($s[2] & 0022) && ($s[2] & 0400) && (!$writable || ($s[2] & 0200)) or fail('PERMISSION_DENIED');
  $s[7] <= $limit or fail('LIMIT_EXCEEDED');
  sysopen(my $fh, $path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK) or fail('FILE_INVALID'); binmode($fh); my @opened = stat($fh);
  for my $i (0,1,2,3,4,7,9,10) { $opened[$i] == $s[$i] or fail('FILE_INVALID'); }
  my $data = ''; while (length($data) <= $limit) { my $n = read($fh, my $chunk, $limit + 1 - length($data)); defined $n or fail('STORAGE_FAILED'); last unless $n; $data .= $chunk; }
  length($data) <= $limit or fail('LIMIT_EXCEEDED'); my @after = stat($fh); for my $i (0,1,7,9,10) { $after[$i] == $opened[$i] or fail('FILE_INVALID'); }
  close($fh) or fail('STORAGE_FAILED'); return { data => encode_base64($data,''), hash => sha256_hex($data) };
}
dir($root,0) or fail('PATH_INVALID');
my $base = "$root/.phi/library";
if (!dir("$root/.phi", $write) || !dir($base,$write)) { print encode_json({exists=>JSON::PP::false}); exit 0; }
my $index = file("$base/index.json", ${REMOTE_LIBRARY_MAX_INDEX_BYTES}, $write);
my $pending = file("$base/.projection-pending.json", 2048, $write);
if ($mode eq 'projection' || $mode eq 'remove') {
  $key =~ /^[a-z0-9-]{1,64}-[a-f0-9]{12}$/ or fail('PATH_INVALID');
  dir("$base/papers",1); my $paper = "$base/papers/$key";
  if (dir($paper,$mode eq 'projection')) {
    file("$paper/meta.json", ${REMOTE_LIBRARY_MAX_INDEX_BYTES},1); file("$paper/note.md", ${REMOTE_LIBRARY_MAX_INDEX_BYTES},1);
    opendir(my $dh,$paper) or fail('PERMISSION_DENIED'); my @children = grep { $_ ne '.' && $_ ne '..' } readdir($dh); closedir($dh);
    @children <= 2 && !grep { $_ ne 'meta.json' && $_ ne 'note.md' } @children or fail('FILE_INVALID');
    if ($mode eq 'remove') { for my $name (@children) { unlink("$paper/$name") or fail('STORAGE_FAILED'); } rmdir($paper) or fail('STORAGE_FAILED'); }
  }
}
print encode_json({exists=>JSON::PP::true,index=>$index,pending=>$pending});`
  return `cd -P -- ${q(root)} || exit 1\nperl -e ${q(source)} -- ${q(root)} ${q(mode)} ${q(key)}\n`
}
