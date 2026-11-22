import argparse
import json
import os
import webbrowser
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

from enablebanking_sdk.constants import PSUType
from enablebanking_sdk.service import EnableBankingIntegration, EnableBankingService


DEFAULT_BASE_URL = "https://api.enablebanking.com"
DEFAULT_OUTPUT = Path(__file__).with_name("anna-session.json")


def parse_authorization_code(value: str) -> str:
    value = value.strip()
    if "://" not in value:
        return value
    query = parse_qs(urlparse(value).query)
    code = query.get("code", [""])[0].strip()
    if not code:
        raise ValueError("The redirect URL does not contain a code parameter.")
    return code


def read_certificate(certificate_file: str) -> str:
    if certificate_file:
        return Path(certificate_file).read_text(encoding="utf-8").strip()
    return os.getenv("ENABLEBANKING_ANNA_CERTIFICATE_PEM", "").strip()


def choose_aspsp(service: EnableBankingService, country: str, psu_type: PSUType, requested_name: str):
    aspsps = service.get_aspsps(country=country, psu_type=psu_type)
    if not aspsps:
        raise RuntimeError(f"No banks were returned for country {country}.")
    if requested_name:
        match = [
            aspsp
            for aspsp in aspsps
            if aspsp.name.lower() == requested_name.lower()
        ]
        if not match:
            raise RuntimeError(f"Bank '{requested_name}' is not available.")
        return match[0]

    print("\nAvailable banks:")
    for index, aspsp in enumerate(aspsps, start=1):
        print(f"  {index}. {aspsp.name}")
    while True:
        selection = input("\nSelect a bank number: ").strip()
        if selection.isdigit() and 1 <= int(selection) <= len(aspsps):
            return aspsps[int(selection) - 1]
        print("Enter one of the displayed numbers.")


def authorize(args: argparse.Namespace) -> Path:
    certificate = read_certificate(args.certificate_file)
    if not args.app_id:
        raise RuntimeError("Set ENABLEBANKING_ANNA_APP_ID or pass --app-id.")
    if not certificate:
        raise RuntimeError(
            "Set ENABLEBANKING_ANNA_CERTIFICATE_PEM or pass --certificate-file."
        )
    if not args.redirect_url:
        raise RuntimeError(
            "Set ENABLEBANKING_ANNA_REDIRECT_URL or pass --redirect-url."
        )

    service = EnableBankingService(
        integration=EnableBankingIntegration(
            base_url=args.base_url,
            app_id=args.app_id,
            certificate=certificate,
        )
    )
    if args.code:
        response = service.authorize_user_session(
            parse_authorization_code(args.code)
        )
        return save_authorization(response, Path(args.output))

    aspsp = choose_aspsp(
        service,
        country=args.country.upper(),
        psu_type=PSUType(args.psu_type),
        requested_name=args.aspsp,
    )
    authorization = service.start_user_session(
        aspsp=aspsp,
        state=uuid4().hex,
        redirect_url=args.redirect_url,
        language=args.language,
        psu_type=PSUType(args.psu_type),
        psu_id=args.psu_id or None,
    )

    print("\nOpening the bank authorization page...")
    webbrowser.open(authorization.url)
    print(authorization.url)
    if args.start_only:
        print(
            "\nComplete the bank login, then rerun this command with "
            "--code <redirect URL or code>."
        )
        return Path(args.output)
    redirect = input(
        "\nAfter approving access, paste the final redirected URL "
        "or its code parameter: "
    )
    response = service.authorize_user_session(parse_authorization_code(redirect))
    return save_authorization(response, Path(args.output))


def save_authorization(response, output: Path) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "session_id": response.session_id,
        "accounts": [account.uid for account in response.accounts],
        "saved_at": datetime.now().isoformat(),
    }
    output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    output.chmod(0o600)

    print(f"\nAuthorized {len(response.accounts)} account(s).")
    print(f"Saved the ignored local session file: {output}")
    print("Use its accounts array as ENABLEBANKING_ANNA_ACCOUNT_UIDS.")
    return output


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Authorize Anna's Enable Banking account from the CLI."
    )
    parser.add_argument(
        "--app-id",
        default=os.getenv("ENABLEBANKING_ANNA_APP_ID", "").strip(),
    )
    parser.add_argument(
        "--base-url",
        default=os.getenv(
            "ENABLEBANKING_BASE_URL", DEFAULT_BASE_URL
        ).strip(),
    )
    parser.add_argument("--certificate-file", default="")
    parser.add_argument(
        "--redirect-url",
        default=os.getenv("ENABLEBANKING_ANNA_REDIRECT_URL", "").strip(),
    )
    parser.add_argument("--country", default="DK")
    parser.add_argument(
        "--psu-type", choices=("personal", "business"), default="personal"
    )
    parser.add_argument("--aspsp", default="", help="Exact bank name.")
    parser.add_argument("--psu-id", default="", help="Optional bank customer ID.")
    parser.add_argument("--language", default="en")
    parser.add_argument(
        "--code",
        default="",
        help="Final redirect URL or authorization code from a prior run.",
    )
    parser.add_argument(
        "--start-only",
        action="store_true",
        help="Open the bank page and exit before requesting the code.",
    )
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    return parser


if __name__ == "__main__":
    authorize(build_parser().parse_args())
