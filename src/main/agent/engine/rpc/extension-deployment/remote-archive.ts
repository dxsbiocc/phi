import { shellQuote as q } from '../../../wrappers/remote-ssh-session'
import { verifyBundleCommand } from './remote-commands'
import type { PhiExtensionBundle } from './types'

function archiveValidator(bundle: PhiExtensionBundle, manifestSize: number): string {
  const expected = [
    ...bundle.files.map((file) => ({ path: file.path, size: file.bytes.length })),
    { path: 'manifest.json', size: manifestSize }
  ]
    .map((file) => `  q{${file.path}} => ${file.size},`)
    .join('\n')
  return String.raw`use strict;
use warnings;

my $archive = shift @ARGV;
open my $fh, '<', $archive or die "PHI_ARCHIVE:open failed\n";
binmode $fh;
my %expected = (
${expected}
);
my %seen;
my $pending_path;
my $zero = "\0" x 512;

sub exact {
  my ($length) = @_;
  my $value = '';
  while (length($value) < $length) {
    my $read = read($fh, my $chunk, $length - length($value));
    die "PHI_ARCHIVE:truncated entry\n" unless defined($read) && $read > 0;
    $value .= $chunk;
  }
  return $value;
}

sub field {
  my ($header, $offset, $length) = @_;
  my $value = substr($header, $offset, $length);
  my $nul = index($value, "\0");
  if ($nul >= 0) {
    die "PHI_ARCHIVE:nonzero field padding\n" if substr($value, $nul) =~ /[^\0]/;
    $value = substr($value, 0, $nul);
  }
  return $value;
}

sub octal_field {
  my ($header, $offset, $length) = @_;
  my $value = substr($header, $offset, $length);
  $value =~ s/[ \0]+$//;
  $value =~ s/^ +//;
  die "PHI_ARCHIVE:invalid numeric field\n" unless $value =~ /\A[0-7]+\z/;
  return oct($value);
}

sub safe_path {
  my ($path) = @_;
  die "PHI_ARCHIVE:absolute path\n" if substr($path, 0, 1) eq '/';
  die "PHI_ARCHIVE:parent path\n" if grep { $_ eq '..' } split('/', $path, -1);
  die "PHI_ARCHIVE:invalid path\n"
    if $path eq '' || $path =~ /[\\\r\n\0]/ || grep { $_ eq '' || $_ eq '.' } split('/', $path, -1);
}

sub payload {
  my ($size) = @_;
  my $data = exact($size);
  my $padding = (512 - ($size % 512)) % 512;
  die "PHI_ARCHIVE:nonzero payload padding\n" if $padding && exact($padding) ne "\0" x $padding;
  return $data;
}

sub pax_path {
  my ($data) = @_;
  my $space = index($data, ' ');
  die "PHI_ARCHIVE:invalid pax path\n" if $space <= 0;
  my $length = substr($data, 0, $space);
  die "PHI_ARCHIVE:invalid pax path\n"
    unless $length =~ /\A[1-9][0-9]*\z/ && $length == length($data);
  my $record = substr($data, $space + 1);
  die "PHI_ARCHIVE:invalid pax path\n"
    unless $record =~ /\Apath=([A-Za-z0-9_\/-]+\.(?:ts|json))\n\z/;
  safe_path($1);
  return $1;
}

while (1) {
  my $header = exact(512);
  if ($header eq $zero) {
    die "PHI_ARCHIVE:missing second end block\n" unless exact(512) eq $zero;
    die "PHI_ARCHIVE:dangling pax path\n" if defined($pending_path);
    my $tail = '';
    my $read = read($fh, $tail, 1);
    die "PHI_ARCHIVE:trailing data\n" unless defined($read) && $read == 0;
    last;
  }
  my $stored = octal_field($header, 148, 8);
  my $checked = $header;
  substr($checked, 148, 8) = ' ' x 8;
  die "PHI_ARCHIVE:header checksum\n" unless $stored == unpack('%32C*', $checked);
  die "PHI_ARCHIVE:format\n"
    unless substr($header, 257, 6) eq "ustar\0" && substr($header, 263, 2) eq '00';
  my $name = field($header, 0, 100);
  my $prefix = field($header, 345, 155);
  my $path = length($prefix) ? "$prefix/$name" : $name;
  safe_path($path);
  my $type = substr($header, 156, 1);
  my $size = octal_field($header, 124, 12);
  die "PHI_ARCHIVE:unsafe mode\n" unless octal_field($header, 100, 8) == 0600;
  die "PHI_ARCHIVE:unsafe owner\n"
    unless octal_field($header, 108, 8) == 0 && octal_field($header, 116, 8) == 0;
  die "PHI_ARCHIVE:unsafe timestamp\n" unless octal_field($header, 136, 12) == 0;
  die "PHI_ARCHIVE:link target\n" if field($header, 157, 100) ne '';
  die "PHI_ARCHIVE:device number\n"
    unless octal_field($header, 329, 8) == 0 && octal_field($header, 337, 8) == 0;

  if ($type eq 'x') {
    die "PHI_ARCHIVE:unexpected pax entry\n"
      unless !defined($pending_path) && $path =~ /\APaxHeaders\/[0-9]+\z/;
    $pending_path = pax_path(payload($size));
    next;
  }
  my %unsafe = (
    '1' => 'hard link',
    '2' => 'symbolic link',
    '3' => 'character device',
    '4' => 'block device',
    '5' => 'directory',
    '6' => 'fifo'
  );
  die "PHI_ARCHIVE:" . ($unsafe{$type} // 'unsupported entry') . "\n" unless $type eq '0';
  my $effective = defined($pending_path) ? $pending_path : $path;
  $pending_path = undef;
  safe_path($effective);
  die "PHI_ARCHIVE:unexpected entry\n" unless exists($expected{$effective});
  die "PHI_ARCHIVE:duplicate entry\n" if $seen{$effective}++;
  die "PHI_ARCHIVE:size mismatch\n" unless $size == $expected{$effective};
  payload($size);
}

die "PHI_ARCHIVE:missing entry\n" unless scalar(keys %seen) == scalar(keys %expected);
close $fh or die "PHI_ARCHIVE:close failed\n";
`
}

/** Validate the archive, replace owned legacy staging, unpack, and verify in one command. */
export function unpackBundleCommand(options: {
  staging: string
  archive: string
  archiveHash: string
  workArchive: string
  bundle: PhiExtensionBundle
  manifestHash: string
  manifestSize: number
}): string {
  const { staging, archive, archiveHash, workArchive, bundle, manifestHash, manifestSize } = options
  const validator = archiveValidator(bundle, manifestSize)
  return `private_file ${q(archive)}
[ "$(hash_file ${q(archive)})" = ${q(archiveHash)} ] || fail 'Uploaded Phi extension bundle did not pass complete-file verification'
perl - ${q(archive)} <<'PHI_EXTENSION_ARCHIVE' || fail 'Unsafe Phi extension archive entry'
${validator}PHI_EXTENSION_ARCHIVE
[ ! -e ${q(workArchive)} ] && [ ! -L ${q(workArchive)} ] || fail 'Extension archive work path already exists'
mv -- ${q(archive)} ${q(workArchive)} || fail 'Cannot claim uploaded extension archive'
cleanup_unpack() {
  if [ -d ${q(staging)} ] && [ ! -L ${q(staging)} ]; then owned ${q(staging)} && rm -rf -- ${q(staging)} || :; fi
  rm -f -- ${q(workArchive)}
}
trap cleanup_unpack EXIT HUP INT TERM
[ -d ${q(staging)} ] && [ ! -L ${q(staging)} ] || fail 'Unsafe extension staging directory'
owned ${q(staging)}
rm -rf -- ${q(staging)} || fail 'Cannot remove previous extension staging'
private_dir ${q(staging)}
tar -xf ${q(workArchive)} -C ${q(staging)} || fail 'Cannot unpack extension archive'
verification=$(
${verifyBundleCommand(staging, bundle, manifestHash)}
)
[ "$verification" = PHI_EXTENSION_VALID ] || fail 'Uploaded Phi extension bundle did not pass complete-file verification'
rm -f -- ${q(workArchive)} || fail 'Cannot remove verified extension archive'
trap - EXIT HUP INT TERM
printf 'PHI_EXTENSION_VALID\n'`
}
